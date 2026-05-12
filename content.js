(function () {
  "use strict";

  if (window.__fzCellPreviewListenerInstalled) return;
  window.__fzCellPreviewListenerInstalled = true;

  const RETRY_DELAYS = [0, 20, 50, 100, 200, 360, 520, 700];
  const CAPTURE_TIMEOUT_MS = 850;
  const EARLY_EMPTY_MIN_STEP_INDEX = 2;
  const EARLY_EMPTY_REQUIRED_HITS = 2;
  const MAX_SEARCH_DEPTH = 10;
  const KEYBOARD_CAPTURE_DELAY_MS = 80;
  const FORMULA_CAPTURE_MIN_ACCEPT_MS = 200;
  const FORMULA_SAME_TEXT_SETTLE_MS = 650;

  const CELL_SELECTOR = "[role='gridcell'], [data-cell], [data-cell-id], td, th";
  const EDITOR_SELECTOR = "[contenteditable]:not([contenteditable='false']),textarea,input[type='text'],input:not([type]),[role='textbox']";
  const FORMULA_SELECTORS = [
    "[data-testid*='formula' i]",
    "[class*='formula' i]",
    "[class*='fx' i]",
    "[aria-label*='公式' i]",
    "[aria-label*='fx' i]",
    "[placeholder*='公式' i]",
    "[placeholder*='fx' i]"
  ];
  const ACTIVE_CELL_SELECTORS = [
    "[aria-selected='true']",
    "[data-selected='true']",
    "[data-active='true']",
    "[role='gridcell'][tabindex='0']",
    "[class*='active'][class*='cell']",
    "[class*='selected'][class*='cell']"
  ];

  const BLOCKED_TEXT_PATTERNS = [
    /暂无当前工作表查看权限/,
    /没有权限/,
    /无权查看/,
    /no\s+(view\s+)?permission/i,
    /access\s+denied/i
  ];

  const UI_NOISE_KEYWORDS = [
    "撤销", "重做", "格式刷", "插入", "合并单元格", "常规", "冻结",
    "筛选", "排序", "条件格式", "下拉列表", "多维表格", "查找和替换",
    "评论", "AI写公式", "更多 AI"
  ];

  let currentSession = null;
  let lastCellContext = null;
  let lastCaptureResult = null;
  let keyboardCaptureTimer = 0;

  document.addEventListener("click", (event) => {
    try {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const context = normalizeCellContext({ x: event.clientX, y: event.clientY });
      if (context) lastCellContext = context;
      startCaptureSession(event.target, event, context);
    } catch (error) {
      emitCaptureError(error, event && event.target instanceof Element ? event.target : null);
    }
  }, false);

  document.addEventListener("keydown", (event) => {
    try {
      if (!event.isTrusted || !isCellNavigationKey(event)) return;
      scheduleKeyboardFocusCapture();
    } catch (_) {}
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "FZ_CAPTURE_CURRENT_CELL") {
      captureCurrentActiveCell();
    }
    if (message.type === "FZ_WRITE_CELL") {
      writeCellFromPanelDetailed(message).then(sendResponse).catch((error) => {
        sendResponse({
          ok: false,
          reason: error && error.message ? error.message : "WRITE_CELL_FAILED"
        });
      });
      return true;
    }
  });

  function startCaptureSession(target, event, context, options) {
    cancelSession();
    const session = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      url: location.href,
      startedAt: new Date().toISOString(),
      startedMs: performance.now(),
      clickTarget: describeClickTarget(target, event),
      clickContext: context || null,
      cellAddress: resolveCellAddress(target, context),
      attempts: [],
      emptyLikelyHits: 0,
      suppressEmpty: Boolean(options && options.suppressEmpty),
      state: "running"
    };
    currentSession = session;

    RETRY_DELAYS.forEach((delay, stepIndex) => {
      window.setTimeout(() => runCaptureAttempt(session, target, stepIndex), delay);
    });

    window.setTimeout(() => {
      if (!isSessionActive(session)) return;
      if (session.sawStalePreviousFormula) {
        finalizeSession(session, "success", "公式栏同步未完成");
        return;
      }
      if (!session.suppressEmpty) {
        emitCellSelected("", "空单元格", session.clickContext, session.cellAddress);
      }
      finalizeSession(session, "success", session.suppressEmpty ? "自动读取未命中" : "空单元格");
    }, CAPTURE_TIMEOUT_MS);
  }

  function runCaptureAttempt(session, target, stepIndex) {
    if (!isSessionActive(session)) return;
    if (!session.cellAddress || stepIndex <= 2) {
      const freshAddress = resolveCellAddress(target, session.clickContext);
      if (freshAddress) session.cellAddress = freshAddress;
    }

    const probes = [
      { key: "formula", source: "公式栏输入区", run: probeFormulaBarText }
    ];

    let stepFormulaEmpty = false;

    for (const probe of probes) {
      const raw = safelyRunProbe(probe.run);
      const text = normalizeCellText(raw);
      const baseEvaluation = evaluateCandidate(text, probe.key, session.cellAddress);
      const evaluation = refineFormulaCaptureEvaluation(session, probe.key, text, baseEvaluation);

      pushAttempt(session, {
        step: stepIndex + 1,
        source: probe.source,
        elapsedMs: elapsedMs(session),
        hit: evaluation.status === "success",
        reason: evaluation.reason,
        candidateLength: text.length,
        candidateSample: sampleText(text),
        details: evaluation.details || null
      });

      if (evaluation.status === "blocked") {
        finalizeSession(session, "blocked", probe.source);
        sendMessage({ type: "FZ_CAPTURE_BLOCKED" });
        return;
      }

      if (probe.key === "formula" && ["cell_address_token", "empty", "not_useful"].includes(evaluation.reason)) stepFormulaEmpty = true;

      if (evaluation.status !== "success") continue;

      rememberCaptureResult(text, session.cellAddress);
      emitCellSelected(text, probe.source, session.clickContext, session.cellAddress);
      finalizeSession(session, "success", probe.source);
      return;
    }

    if (stepFormulaEmpty) {
      session.emptyLikelyHits += 1;
    } else {
      session.emptyLikelyHits = 0;
    }

    if (stepIndex >= EARLY_EMPTY_MIN_STEP_INDEX && session.emptyLikelyHits >= EARLY_EMPTY_REQUIRED_HITS) {
      if (!session.suppressEmpty) {
        emitCellSelected("", "空单元格", session.clickContext, session.cellAddress);
      }
      finalizeSession(session, "success", session.suppressEmpty ? "自动读取未命中" : "空单元格(快速)");
    }
  }

  function captureCurrentActiveCell() {
    try {
      const focusTarget = resolveFocusedCellCaptureTarget();
      const target = focusTarget.target || document.body;
      const context = focusTarget.context || lastCellContext;
      startCaptureSession(target, null, context, { suppressEmpty: true });
    } catch (error) {
      emitCaptureError(error, document.body);
    }
  }

  function captureKeyboardFocusedCell() {
    const focusTarget = resolveFocusedCellCaptureTarget();
    if (!focusTarget.context && !focusTarget.target) return;
    startCaptureSession(focusTarget.target || document.body, null, focusTarget.context || lastCellContext, { suppressEmpty: false });
  }

  function scheduleKeyboardFocusCapture() {
    window.clearTimeout(keyboardCaptureTimer);
    keyboardCaptureTimer = window.setTimeout(() => {
      try {
        captureKeyboardFocusedCell();
      } catch (error) {
        emitCaptureError(error, document.body);
      }
    }, KEYBOARD_CAPTURE_DELAY_MS);
  }

  function isCellNavigationKey(event) {
    const key = event && event.key;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Enter"].includes(key)) return false;
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    const active = getDeepActiveElement();
    if (active instanceof Element && isFormulaEditorElement(active)) return false;
    return true;
  }

  function resolveFocusedCellCaptureTarget() {
    const activeCell = findCurrentActiveCellElement();
    if (activeCell) {
      return {
        target: activeCell,
        context: getElementCenterContext(activeCell)
      };
    }

    const active = getDeepActiveElement();
    const editable = resolveEditableRoot(active);
    const target = editable instanceof Element ? editable : (active instanceof Element ? active : null);
    const context = target instanceof Element ? getElementCenterContext(target) : null;
    return { target, context };
  }

  function findCurrentActiveCellElement() {
    const seen = new Set();
    const candidates = [];

    ACTIVE_CELL_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof Element) || seen.has(node)) return;
        seen.add(node);
        if (!isVisibleElement(node) || isFormulaEditorElement(node)) return;
        const cell = node.matches(CELL_SELECTOR)
          ? node
          : closestWithinDepth(node, CELL_SELECTOR, MAX_SEARCH_DEPTH);
        const candidate = cell instanceof Element ? cell : node;
        if (!isVisibleElement(candidate)) return;
        candidates.push({
          element: candidate,
          score: scoreActiveCellCandidate(candidate)
        });
      });
    });

    const active = getDeepActiveElement();
    if (active instanceof Element && !isFormulaEditorElement(active)) {
      const activeCell = active.matches(CELL_SELECTOR)
        ? active
        : closestWithinDepth(active, CELL_SELECTOR, MAX_SEARCH_DEPTH);
      if (activeCell instanceof Element && isVisibleElement(activeCell) && !seen.has(activeCell)) {
        candidates.push({
          element: activeCell,
          score: scoreActiveCellCandidate(activeCell) + 10
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].element : null;
  }

  function scoreActiveCellCandidate(element) {
    if (!(element instanceof Element)) return 0;
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (element.matches(CELL_SELECTOR)) score += 40;
    if (rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight) score += 20;
    if (extractTextFromElement(element, true)) score += 10;
    const hint = `${element.className || ""} ${element.getAttribute("aria-selected") || ""} ${element.getAttribute("data-selected") || ""} ${element.getAttribute("data-active") || ""}`;
    if (/true|active|selected/i.test(hint)) score += 15;
    return score;
  }

  function getElementCenterContext(element) {
    if (!(element instanceof Element) || !isVisibleElement(element)) return null;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return normalizeCellContext({ x, y });
  }

  async function writeCellFromPanel(message) {
    const text = normalizeWriteText(message.text);
    const context = normalizeCellContext(message.cellContext);
    const frameValidation = validateWriteFrameForContext(context);
    if (!frameValidation.ok) return { ok: false, reason: "NON_SHEET_FRAME" };

    if (context) {
      const focusResult = focusCellByPointDetailed(context);
      if (!focusResult || !focusResult.ok) return { ok: false, reason: "TARGET_CELL_FOCUS_FAILED" };
      await sleep(24);
    } else {
      return { ok: false, reason: "MISSING_CELL_CONTEXT" };
    }

    const editor = findWriteTargetEditor(context);
    if (!editor) return { ok: false, reason: "FORMULA_EDITOR_NOT_FOUND" };

    setEditorText(editor, text);
    commitEditor(editor);
    emitCellSelected(text, "输入模式写回", context);
    return { ok: true };
  }

  async function writeCellFromPanelDetailed(message) {
    const text = normalizeWriteText(message && message.text);
    const requestedContext = normalizeCellContext(message && message.cellContext);
    const targetResolution = resolveWriteTargetContext(message, requestedContext);
    const context = targetResolution.context;
    const debugSession = createWriteDebugSession(message, text, requestedContext, context, targetResolution);
    let step = 1;

    pushWriteAttempt(debugSession, {
      step: step++,
      stage: "request_received",
      source: "写回请求",
      hit: true,
      reason: "received",
      candidateText: text,
      details: {
        incomingTextLength: text.length,
        hasIncomingContext: Boolean(requestedContext),
        hasResolvedContext: Boolean(context)
      }
    });

    const frameValidation = validateWriteFrameForContext(context);
    pushWriteAttempt(debugSession, {
      step: step++,
      stage: "frame_validation",
      source: "write_frame_validation",
      hit: Boolean(frameValidation && frameValidation.ok),
      reason: frameValidation && frameValidation.reason ? frameValidation.reason : "unknown",
      candidateText: "",
      details: frameValidation
    });

    if (!frameValidation || !frameValidation.ok) {
      emitWriteDebugSession(debugSession, "error", "NON_SHEET_FRAME");
      return {
        ok: false,
        reason: "NON_SHEET_FRAME",
        debugSessionId: debugSession.id
      };
    }

    let focusResult = null;
    if (context) {
      focusResult = focusCellByPointDetailed(context);
      pushWriteAttempt(debugSession, {
        step: step++,
        stage: "focus_cell",
        source: "定位并激活单元格",
        hit: Boolean(focusResult && focusResult.ok),
        reason: focusResult && focusResult.reason ? focusResult.reason : "unknown",
        candidateText: "",
        details: focusResult
      });
      await sleep(24);
    } else {
      pushWriteAttempt(debugSession, {
        step: step++,
        stage: "focus_cell",
        source: "定位并激活单元格",
        hit: false,
        reason: "missing_cell_context",
        candidateText: "",
        details: {
          incomingContext: requestedContext,
          cachedContext: lastCellContext || null
        }
      });
    }

    const activeAfterFocus = getDeepActiveElement();
    pushWriteAttempt(debugSession, {
      step: step++,
      stage: "active_snapshot",
      source: "焦点元素快照",
      hit: activeAfterFocus instanceof Element,
      reason: activeAfterFocus instanceof Element ? "active_element_detected" : "active_element_missing",
      candidateText: extractEditableText(activeAfterFocus),
      details: { activeElement: describeElementForDebug(activeAfterFocus) }
    });

    if (!context || (focusResult && !focusResult.ok)) {
      pushWriteAttempt(debugSession, {
        step: step++,
        stage: "stop_write",
        source: "中止写回",
        hit: false,
        reason: !context ? "missing_cell_context" : "target_cell_focus_failed",
        candidateText: "",
        details: {
          focusResult,
          requestedContext,
          cachedContext: lastCellContext || null
        }
      });
      emitWriteDebugSession(debugSession, "error", !context ? "MISSING_CELL_CONTEXT" : "TARGET_CELL_FOCUS_FAILED");
      return {
        ok: false,
        reason: !context ? "MISSING_CELL_CONTEXT" : "TARGET_CELL_FOCUS_FAILED",
        debugSessionId: debugSession.id
      };
    }

    const isClearingCell = isClearWriteText(text);
    if (isClearingCell) {
      const clearResult = await runClearCellStrategy(context);
      pushWriteAttempt(debugSession, {
        step: step++,
        stage: "clear_strategy",
        source: "clear_cell_strategy",
        hit: Boolean(clearResult && clearResult.ok),
        reason: clearResult && clearResult.reason ? clearResult.reason : "unknown",
        candidateText: clearResult && typeof clearResult.observedFormula === "string" ? clearResult.observedFormula : "",
        details: clearResult
      });

      if (clearResult && clearResult.ok) {
        emitCellSelected(text, "clear_cell", context);
        pushWriteAttempt(debugSession, {
          step: step++,
          stage: "panel_preview",
          source: "panel_preview",
          hit: true,
          reason: "sent_after_clear",
          candidateText: text,
          details: { source: "clear_cell" }
        });
        emitWriteDebugSession(debugSession, "success", "clear_ok");
        return { ok: true, debugSessionId: debugSession.id, writeStrategy: "clear" };
      }
    }

    if (!isClearingCell && shouldPreferNativePasteFirst()) {
      pushWriteAttempt(debugSession, {
        step: step++,
        stage: "synthetic_paste_skipped",
        source: "synthetic_paste_skipped",
        hit: false,
        reason: "native_paste_first",
        candidateText: "",
        details: getWriteStrategyAdaptationState()
      });

      const preferredNativePasteResult = await runNativeClipboardPasteStrategy(text, context, {
        clipboardPrimed: Boolean(message && message.clipboardPrimed)
      });
      pushWriteAttempt(debugSession, {
        step: step++,
        stage: "native_paste_strategy",
        source: "native_paste_strategy",
        hit: Boolean(preferredNativePasteResult && preferredNativePasteResult.ok),
        reason: preferredNativePasteResult && preferredNativePasteResult.reason ? preferredNativePasteResult.reason : "unknown",
        candidateText: preferredNativePasteResult && typeof preferredNativePasteResult.observedFormula === "string" ? preferredNativePasteResult.observedFormula : "",
        details: preferredNativePasteResult
      });

      if (preferredNativePasteResult && preferredNativePasteResult.ok) {
        emitCellSelected(text, "native_paste_writeback", context);
        pushWriteAttempt(debugSession, {
          step: step++,
          stage: "panel_preview",
          source: "panel_preview",
          hit: true,
          reason: "sent_after_native_paste",
          candidateText: text,
          details: { source: "native_paste_writeback", nativeFirst: true }
        });
        emitWriteDebugSession(debugSession, "success", "native_paste_ok");
        return { ok: true, debugSessionId: debugSession.id, writeStrategy: "native_paste_first" };
      }

      if (isNativePasteLikelyDispatched(preferredNativePasteResult)) {
        emitCellSelected(text, "native_paste_pending_lark_sync", context);
        pushWriteAttempt(debugSession, {
          step: step++,
          stage: "panel_preview",
          source: "panel_preview",
          hit: true,
          reason: "sent_after_native_paste_pending_lark_sync",
          candidateText: text,
          details: { source: "native_paste_pending_lark_sync", nativeFirst: true }
        });
        emitWriteDebugSession(debugSession, "success", "native_paste_dispatched_pending_lark_sync");
        return {
          ok: true,
          debugSessionId: debugSession.id,
          writeStrategy: "native_paste_first_pending_lark_sync",
          pendingVerification: true
        };
      }

    }

    if (!isClearingCell) {
    const pasteResult = await runPasteWriteStrategy(text, context);
    pushWriteAttempt(debugSession, {
      step: step++,
      stage: "paste_strategy",
      source: "粘贴写入策略",
      hit: Boolean(pasteResult && pasteResult.ok),
      reason: pasteResult && pasteResult.reason ? pasteResult.reason : "unknown",
      candidateText: pasteResult && typeof pasteResult.observedFormula === "string" ? pasteResult.observedFormula : "",
      details: pasteResult
    });

    if (pasteResult && pasteResult.ok) {
      emitCellSelected(text, "粘贴写回", context);
      pushWriteAttempt(debugSession, {
        step: step++,
        stage: "panel_preview",
        source: "回传侧栏预览",
        hit: true,
        reason: "sent_after_paste",
        candidateText: text,
        details: { source: "粘贴写回" }
      });
      emitWriteDebugSession(debugSession, "success", "paste_ok");
      return { ok: true, debugSessionId: debugSession.id, writeStrategy: "paste" };
    }

    }

    const editorSelection = findWriteTargetEditorDetailed(context);
    const editor = editorSelection.editor;
    pushWriteAttempt(debugSession, {
      step: step++,
      stage: "editor_selection",
      source: "编辑器选择",
      hit: Boolean(editor),
      reason: editorSelection.reason || (editor ? "ok" : "not_found"),
      candidateText: extractEditableText(editor),
      details: {
        route: editorSelection.route || "",
        selectedEditor: describeElementForDebug(editor),
        activeElement: describeElementForDebug(editorSelection.activeElement),
        formulaCandidates: editorSelection.formulaCandidates || [],
        fallbackCandidates: editorSelection.fallbackCandidates || [],
        inCellCandidates: editorSelection.inCellCandidates || [],
        activeFlags: editorSelection.activeFlags || {}
      }
    });

    if (!editor) {
      emitWriteDebugSession(debugSession, "error", "FORMULA_EDITOR_NOT_FOUND");
      return { ok: false, reason: "FORMULA_EDITOR_NOT_FOUND", debugSessionId: debugSession.id };
    }

    const beforeWrite = extractEditableText(editor);
    const setResult = setEditorTextDetailed(editor, text);
    const afterWrite = extractEditableText(editor);
    pushWriteAttempt(debugSession, {
      step: step++,
      stage: "editor_set_text",
      source: "写入编辑器",
      hit: Boolean(setResult && setResult.ok !== false),
      reason: setResult && setResult.reason ? setResult.reason : "ok",
      candidateText: afterWrite,
      details: {
        ...setResult,
        beforeWriteLength: beforeWrite.length,
        beforeWriteSample: sampleText(beforeWrite),
        afterWriteLength: afterWrite.length,
        afterWriteSample: sampleText(afterWrite)
      }
    });

    const commitResult = commitEditorDetailed(editor);
    pushWriteAttempt(debugSession, {
      step: step++,
      stage: "editor_commit",
      source: "提交编辑内容",
      hit: Boolean(commitResult && commitResult.ok),
      reason: commitResult && commitResult.reason ? commitResult.reason : "unknown",
      candidateText: "",
      details: commitResult
    });

    const verifyResult = await verifyWritePersisted(text, context, editor);
    pushWriteAttempt(debugSession, {
      step: step++,
      stage: "editor_verify",
      source: "写回落盘校验",
      hit: Boolean(verifyResult && verifyResult.ok),
      reason: verifyResult && verifyResult.reason ? verifyResult.reason : "unknown",
      candidateText: verifyResult && typeof verifyResult.observedFormula === "string" ? verifyResult.observedFormula : "",
      details: verifyResult
    });

    if ((!verifyResult || !verifyResult.ok) && setResult && setResult.ok !== false && commitResult && commitResult.ok) {
      emitCellSelected(text, "输入模式写回(等待飞书同步)", context);
      pushWriteAttempt(debugSession, {
        step: step++,
        stage: "panel_preview",
        source: "回传侧栏预览",
        hit: true,
        reason: "sent_after_editor_commit_pending_lark_sync",
        candidateText: text,
        details: { source: "输入模式写回(等待飞书同步)" }
      });
      emitWriteDebugSession(debugSession, "success", "editor_commit_dispatched_pending_lark_sync");
      return {
        ok: true,
        debugSessionId: debugSession.id,
        writeStrategy: "editor_commit_pending_lark_sync",
        pendingVerification: true
      };
    }

    if (!verifyResult || !verifyResult.ok) {
      emitWriteDebugSession(debugSession, "error", "WRITE_NOT_PERSISTED");
      return { ok: false, reason: "WRITE_NOT_PERSISTED", debugSessionId: debugSession.id };
    }

    emitCellSelected(text, "输入模式写回", context);
    pushWriteAttempt(debugSession, {
      step: step++,
      stage: "panel_preview",
      source: "回传侧栏预览",
      hit: true,
      reason: "sent",
      candidateText: text,
      details: { source: "输入模式写回" }
    });

    emitWriteDebugSession(debugSession, "success", "ok");
    return { ok: true, debugSessionId: debugSession.id };
  }

  function resolveWriteTargetContext(message, requestedContext) {
    const paneLocked = Boolean(message && message.paneLocked);
    const writeTargetMode = message && message.writeTargetMode ? String(message.writeTargetMode) : "";
    const mode = writeTargetMode === "typing_snapshot"
      ? "typing_snapshot_context"
      : (paneLocked ? "locked_pane_context" : "requested_context");
    return {
      context: requestedContext || null,
      mode,
      writeTargetMode,
      paneLocked,
      requestedContext: requestedContext || null,
      displayContext: normalizeCellContext(message && message.displayContext),
      typingSnapshotContext: normalizeCellContext(message && message.typingSnapshotContext),
      currentFocusContext: null,
      currentFocusTarget: null
    };
  }

  function findWriteTargetEditor(context) {
    const formula = findBestFormulaEditor();
    if (formula) return formula;

    const active = getDeepActiveElement();
    if (isEditableElement(active) && isVisibleElement(active)) {
      return active;
    }

    const candidates = [];
    document.querySelectorAll(EDITOR_SELECTOR).forEach((node) => {
      if (!(node instanceof Element) || !isVisibleElement(node)) return;
      const rect = node.getBoundingClientRect();
      let score = 0;
      if (rect.top <= 340) score += 25;
      if (rect.width >= 120) score += 10;
      if (isLikelyFormulaBar(node)) score += 35;
      if (context) {
        const dy = Math.abs(rect.top - context.y);
        if (dy < 180) score += 8;
      }
      candidates.push({ element: node, score });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].element : null;
  }

  function findWriteTargetEditorDetailed(context) {
    const activeRaw = getDeepActiveElement();
    const active = resolveEditableRoot(activeRaw);
    const activeIsEditable = isEditableElement(active);
    const activeNearContext = isElementNearPoint(active, context, 220);
    const activeIsFormula = isFormulaEditorElement(active);
    const activeOnSheetCanvas = isElementInsideSheetCanvas(active, context);
    const activeIsSheetProxy = isLikelySheetProxyEditor(active, context);
    const inCellCandidates = collectInCellEditableCandidates(context);

    if (activeIsEditable && !activeIsFormula && (activeNearContext || activeOnSheetCanvas || activeIsSheetProxy)) {
      return {
        editor: active,
        route: activeIsSheetProxy ? "active_sheet_proxy" : "active_element",
        reason: activeIsSheetProxy
          ? "active_proxy_after_canvas_focus"
          : (activeNearContext ? "active_editor_near_click" : "active_editor_on_canvas"),
        activeElement: active,
        formulaCandidates: [],
        fallbackCandidates: [],
        inCellCandidates: summarizeCandidateElements(inCellCandidates),
        activeFlags: {
          activeIsEditable,
          activeNearContext,
          activeOnSheetCanvas,
          activeIsSheetProxy
        }
      };
    }

    if (inCellCandidates.length) {
      return {
        editor: inCellCandidates[0].element,
        route: "in_cell_candidates",
        reason: "in_cell_candidate_selected",
        activeElement: active instanceof Element ? active : getDeepActiveElement(),
        formulaCandidates: [],
        fallbackCandidates: [],
        inCellCandidates: summarizeCandidateElements(inCellCandidates),
        activeFlags: {
          activeIsEditable,
          activeNearContext,
          activeOnSheetCanvas,
          activeIsSheetProxy
        }
      };
    }

    return {
      editor: null,
      route: "in_cell_only",
      reason: "no_in_cell_editor",
      activeElement: active instanceof Element ? active : null,
      formulaCandidates: [],
      fallbackCandidates: [],
      inCellCandidates: summarizeCandidateElements(inCellCandidates),
      activeFlags: {
        activeIsEditable,
        activeNearContext,
        activeOnSheetCanvas,
        activeIsSheetProxy
      }
    };
  }

  function collectInCellEditableCandidates(context) {
    const canvasRect = getSheetCanvasRect(context);
    const candidates = [];
    document.querySelectorAll(EDITOR_SELECTOR).forEach((node) => {
      if (!(node instanceof Element)) return;
      const root = resolveEditableRoot(node);
      if (!(root instanceof Element)) return;
      if (!isEditableElement(root) || !isVisibleElement(root)) return;
      if (isFormulaEditorElement(root)) return;
      if (!isElementLikelyInCellEditor(root, context, canvasRect)) return;
      const rect = root.getBoundingClientRect();
      let score = 0;
      if (context) {
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = centerX - context.x;
        const dy = centerY - context.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        score += Math.max(0, 260 - distance);
      }
      if (rect.height <= 8) score += 20;
      if (rect.height <= 20) score += 8;
      if (canvasRect && rect.top >= canvasRect.top && rect.top <= canvasRect.bottom) score += 12;
      candidates.push({ element: root, score, selector: "IN_CELL_EDITABLE" });
    });
    candidates.sort((a, b) => b.score - a.score);
    return dedupeElementCandidates(candidates);
  }

  function dedupeElementCandidates(candidates) {
    const seen = new Set();
    const output = [];
    (Array.isArray(candidates) ? candidates : []).forEach((item) => {
      const element = item && item.element;
      if (!(element instanceof Element)) return;
      if (seen.has(element)) return;
      seen.add(element);
      output.push(item);
    });
    return output;
  }

  function isElementLikelyInCellEditor(element, context, canvasRect) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const classHint = `${element.className || ""} ${(element.closest("[class]") || {}).className || ""}`.toLowerCase();
    if (/(zoom|footer|search|filter|formula|func)/.test(classHint)) return false;

    if (canvasRect) {
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const inCanvasX = centerX >= canvasRect.left - 20 && centerX <= canvasRect.right + 20;
      const inCanvasY = centerY >= canvasRect.top - 20 && centerY <= canvasRect.bottom + 20;
      if (!inCanvasX || !inCanvasY) return false;
    }

    if (context) {
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = centerX - context.x;
      const dy = centerY - context.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > 360) return false;
    }

    return true;
  }

  function getSheetCanvasRect(context) {
    let canvas = null;
    if (context && Number.isFinite(context.x) && Number.isFinite(context.y)) {
      const atPoint = document.elementFromPoint(context.x, context.y);
      if (atPoint instanceof Element) {
        canvas = atPoint.closest("canvas.faster-single-canvas");
      }
    }
    if (!(canvas instanceof Element)) {
      const list = Array.from(document.querySelectorAll("canvas.faster-single-canvas")).filter((el) => isVisibleElement(el));
      canvas = list.length ? list[0] : null;
    }
    if (!(canvas instanceof Element)) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  function isElementInsideSheetCanvas(element, context) {
    if (!(element instanceof Element)) return false;
    const canvasRect = getSheetCanvasRect(context);
    if (!canvasRect) return false;
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    return centerX >= canvasRect.left - 20 &&
      centerX <= canvasRect.right + 20 &&
      centerY >= canvasRect.top - 20 &&
      centerY <= canvasRect.bottom + 20;
  }

  function isLikelySheetProxyEditor(element, context) {
    if (!(element instanceof Element) || !context) return false;
    if (!isEditableElement(element) || isFormulaEditorElement(element)) return false;

    const x = Number(context.x);
    const y = Number(context.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

    const atPoint = document.elementFromPoint(x, y);
    const pointOnSheetCanvas = atPoint instanceof Element && Boolean(atPoint.closest("canvas.faster-single-canvas"));
    if (!pointOnSheetCanvas) return false;

    const canvasRect = getSheetCanvasRect(context);
    if (!canvasRect) return false;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const classHint = `${element.className || ""} ${(element.closest("[class]") || {}).className || ""}`.toLowerCase();
    if (/(search|filter|comment|menu|toolbar|formula|func)/.test(classHint)) return false;

    const appearsOffscreen = rect.bottom <= canvasRect.top ||
      rect.top >= canvasRect.bottom ||
      rect.right <= canvasRect.left ||
      rect.left >= canvasRect.right ||
      rect.top < 0 ||
      rect.left < 0 ||
      rect.left >= window.innerWidth ||
      rect.top >= window.innerHeight;
    const appearsProxySized = rect.height <= 32 && rect.width >= 20;
    return appearsOffscreen && appearsProxySized;
  }

  function collectFormulaCandidateDiagnostics() {
    const seen = new Set();
    const candidates = [];

    FORMULA_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof Element)) return;
        const editable = resolveFormulaEditable(node);
        if (!(editable instanceof Element) || seen.has(editable)) return;
        seen.add(editable);
        candidates.push({ element: editable, score: scoreFormulaCandidate(editable), selector });
      });
    });

    document.querySelectorAll(EDITOR_SELECTOR).forEach((node) => {
      if (!(node instanceof Element) || seen.has(node)) return;
      if (!isLikelyFormulaBar(node)) return;
      seen.add(node);
      candidates.push({ element: node, score: scoreFormulaCandidate(node), selector: "EDITOR_SELECTOR" });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  function summarizeCandidateElements(candidates) {
    return (Array.isArray(candidates) ? candidates : []).slice(0, 8).map((item) => ({
      score: Number(item.score || 0),
      selector: item.selector || "",
      element: describeElementForDebug(item.element),
      valueSample: sampleText(extractEditableText(item.element))
    }));
  }

  function describeElementForDebug(element) {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      className: typeof element.className === "string" ? element.className.slice(0, 140) : "",
      role: element.getAttribute("role") || "",
      ariaLabel: (element.getAttribute("aria-label") || "").slice(0, 140),
      placeholder: (element.getAttribute("placeholder") || "").slice(0, 140),
      editable: isContentEditableElement(element)
        ? "contenteditable"
        : (element instanceof HTMLTextAreaElement ? "textarea" : (element instanceof HTMLInputElement ? `input:${element.type || "text"}` : "none")),
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function createWriteDebugSession(message, text, requestedContext, resolvedContext, targetResolution) {
    return {
      id: `write-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      url: location.href,
      startedAt: new Date().toISOString(),
      startedMs: performance.now(),
      clickTarget: describeClickTarget(
        document.body,
        resolvedContext ? { clientX: resolvedContext.x, clientY: resolvedContext.y } : null
      ),
      attempts: [],
      writeRequest: {
        textLength: text.length,
        textSample: sampleText(text),
        requestedContext: requestedContext || null,
        resolvedContext: resolvedContext || null,
        displayContext: normalizeCellContext(message && message.displayContext),
        displayCellAddress: normalizeCellAddress(message && message.displayCellAddress),
        typingSnapshotContext: normalizeCellContext(message && message.typingSnapshotContext),
        typingSnapshotAddress: normalizeCellAddress(message && message.typingSnapshotAddress),
        writeContext: resolvedContext || null,
        writeTargetMode: message && message.writeTargetMode ? String(message.writeTargetMode) : "",
        incomingCellContext: normalizeCellContext(message && message.cellContext),
        cachedCellContext: lastCellContext || null,
        paneLocked: Boolean(message && message.paneLocked),
        targetResolution: targetResolution || null,
        clipboardPrimed: Boolean(message && message.clipboardPrimed),
        clipboardPrime: message && message.clipboardPrime ? message.clipboardPrime : null,
        frameInfo: {
          isTopFrame: window === window.top,
          frameUrl: location.href
        }
      },
      state: "running"
    };
  }

  function emitWriteDebugSession(session, status, reason) {
    const durationMs = Math.max(0, Math.round(performance.now() - session.startedMs));
    sendMessage({
      type: "FZ_CAPTURE_DEBUG",
      debug: {
        sessionId: session.id,
        url: session.url,
        clickTarget: session.clickTarget,
        startedAt: session.startedAt,
        endedAt: new Date().toISOString(),
        durationMs,
        attempts: session.attempts,
        writeRequest: session.writeRequest,
        writePerformance: buildWritePerformanceSummary(session, status, reason, durationMs),
        finalResult: {
          status: status === "success" ? "success" : "error",
          chosenSource: "写回链路",
          reason: reason || ""
        }
      }
    });
  }

  function buildWritePerformanceSummary(session, status, reason, durationMs) {
    const attempts = Array.isArray(session && session.attempts) ? session.attempts : [];
    const strategyStages = {
      clear_strategy: "clear",
      paste_strategy: "synthetic_paste",
      native_paste_strategy: "native_clipboard_paste",
      editor_selection: "editor_direct_write",
      editor_set_text: "editor_direct_write",
      editor_commit: "editor_direct_write",
      editor_verify: "editor_direct_write"
    };
    const attemptedStrategies = {};
    const fallbackPath = [];
    const allStrategies = ["clear", "synthetic_paste", "native_clipboard_paste", "editor_direct_write"];
    const stageTimings = attempts.map((attempt, index) => {
      const elapsedMs = Number(attempt && attempt.elapsedMs);
      const previousElapsedMs = index > 0 ? Number(attempts[index - 1] && attempts[index - 1].elapsedMs) : 0;
      const deltaMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs - (Number.isFinite(previousElapsedMs) ? previousElapsedMs : 0)) : 0;
      const stage = attempt && attempt.stage ? attempt.stage : `step_${Number(attempt && attempt.step || index + 1)}`;
      const strategy = strategyStages[stage] || "";
      if (strategy && !attemptedStrategies[strategy]) {
        attemptedStrategies[strategy] = true;
        fallbackPath.push(strategy);
      }
      return {
        step: Number(attempt && attempt.step || index + 1),
        stage,
        deltaMs,
        elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
        hit: Boolean(attempt && attempt.hit),
        reason: attempt && attempt.reason ? attempt.reason : "",
        waitMsInDetails: sumWaitMs(attempt && attempt.details)
      };
    });

    const slowestStages = stageTimings
      .slice()
      .sort((a, b) => b.deltaMs - a.deltaMs)
      .slice(0, 5);

    return {
      totalMs: durationMs,
      status: status === "success" ? "success" : "error",
      finalReason: reason || "",
      attemptedStrategies,
      skippedStrategies: allStrategies.filter((strategy) => !attemptedStrategies[strategy]),
      successfulStrategy: inferSuccessfulWriteStrategy(reason),
      adaptation: getWriteStrategyAdaptationState(),
      fallbackPath,
      slowestStages,
      stageTimings
    };
  }

  function inferSuccessfulWriteStrategy(reason) {
    const text = String(reason || "");
    if (text.includes("clear")) return "clear";
    if (text.includes("native_paste")) return "native_clipboard_paste";
    if (text.includes("paste")) return "synthetic_paste";
    if (text.includes("editor") || text === "ok") return "editor_direct_write";
    return "";
  }

  function shouldPreferNativePasteFirst() {
    return true;
  }

  function getWriteStrategyAdaptationState() {
    return {
      mode: "native_paste_first",
      preferNativePaste: true
    };
  }

  function sumWaitMs(value) {
    if (value == null) return 0;
    if (Array.isArray(value)) {
      return value.reduce((total, item) => total + sumWaitMs(item), 0);
    }
    if (typeof value === "object") {
      return Object.keys(value).reduce((total, key) => {
        const own = key === "waitMs" && Number.isFinite(Number(value[key])) ? Number(value[key]) : 0;
        return total + own + sumWaitMs(value[key]);
      }, 0);
    }
    return 0;
  }

  function pushWriteAttempt(session, payload) {
    const candidateText = typeof payload.candidateText === "string" ? payload.candidateText : "";
    pushAttempt(session, {
      step: Number(payload.step || 0),
      stage: payload.stage || "",
      source: payload.source || "",
      elapsedMs: elapsedMs(session),
      hit: Boolean(payload.hit),
      reason: payload.reason || "",
      candidateLength: candidateText.length,
      candidateSample: sampleText(candidateText),
      details: sanitizeDebugDetails(payload.details)
    });
  }

  function sanitizeDebugDetails(details) {
    if (details == null) return null;
    if (typeof details === "string") return details.slice(0, 500);
    if (typeof details === "number" || typeof details === "boolean") return details;
    if (Array.isArray(details)) return details.slice(0, 10).map((item) => sanitizeDebugDetails(item));
    if (typeof details === "object") {
      const result = {};
      Object.keys(details).slice(0, 24).forEach((key) => {
        result[key] = sanitizeDebugDetails(details[key]);
      });
      return result;
    }
    return String(details);
  }

  function focusCellByPointDetailed(context) {
    const x = Number(context && context.x);
    const y = Number(context && context.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, reason: "invalid_point", context: context || null };
    }
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return { ok: false, reason: "point_out_of_viewport", context: { x, y, innerWidth: window.innerWidth, innerHeight: window.innerHeight } };
    }

    const target = document.elementFromPoint(x, y);
    if (!(target instanceof Element)) {
      return { ok: false, reason: "element_from_point_empty", context: { x, y } };
    }

    const dispatches = [];
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
      let dispatched = false;
      let errorMessage = "";
      try {
        dispatched = target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0
        }));
      } catch (error) {
        errorMessage = error && error.message ? error.message : "dispatch_failed";
      }
      dispatches.push({ type, dispatched, error: errorMessage });
    });

    return {
      ok: true,
      reason: "events_dispatched",
      context: { x, y },
      target: describeElementForDebug(target),
      dispatches
    };
  }

  function validateWriteFrameForContext(context) {
    if (!context) {
      return {
        ok: true,
        reason: "missing_context_checked_later",
        frameUrl: location.href,
        isTopFrame: window === window.top
      };
    }

    const hasSheetCanvas = Boolean(document.querySelector("canvas.faster-single-canvas"));
    const hasFormulaEditor = Boolean(findBestFormulaEditor());
    const isAboutBlankFrame = window !== window.top && location.href === "about:blank";
    const ok = !isAboutBlankFrame && (hasSheetCanvas || hasFormulaEditor);
    return {
      ok,
      reason: ok ? "sheet_frame_detected" : "non_sheet_frame",
      frameUrl: location.href,
      isTopFrame: window === window.top,
      hasSheetCanvas,
      hasFormulaEditor,
      context
    };
  }

  function probeFormulaBarText() {
    const editor = findBestFormulaEditor();
    return editor ? extractEditableText(editor) : "";
  }

  function probeVisibleFormulaBarText(context) {
    const canvasRect = getSheetCanvasRect(context);
    const topMin = canvasRect ? Math.max(0, canvasRect.top - 120) : 80;
    const topMax = canvasRect ? Math.max(topMin + 8, canvasRect.top - 4) : 220;
    const candidates = [];

    document.querySelectorAll("div,span,input,textarea,[contenteditable]:not([contenteditable='false']),[role='textbox']").forEach((node) => {
      if (!(node instanceof Element) || !isVisibleElement(node)) return;
      const rect = node.getBoundingClientRect();
      if (!isLikelyVisibleFormulaBarRect(rect, topMin, topMax)) return;
      const text = extractVisibleFormulaCandidateText(node);
      if (!text || !isUsefulText(text)) return;
      candidates.push({
        text,
        score: scoreVisibleFormulaCandidate(node, rect, canvasRect, text)
      });
    });

    return pickBestCandidateText(candidates);
  }

  function isLikelyVisibleFormulaBarRect(rect, topMin, topMax) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    if (rect.top < topMin || rect.top > topMax) return false;
    if (rect.height > 64 || rect.width < 20) return false;
    return true;
  }

  function extractVisibleFormulaCandidateText(element) {
    if (!(element instanceof Element)) return "";
    let text = "";
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      text = element.value || "";
    } else if (isContentEditableElement(element)) {
      text = element.textContent || "";
    } else {
      text = element.innerText || element.textContent || "";
    }
    text = normalizeElementText(text);
    if (!text || text.length > 2000) return "";
    if (isLikelyToolbarText(element, text)) return "";
    return text;
  }

  function isLikelyToolbarText(element, text) {
    const normalized = String(text || "").trim();
    if (!normalized) return true;
    const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
    const classHint = `${element.className || ""} ${element.id || ""} ${element.getAttribute("role") || ""}`.toLowerCase();
    if (/toolbar|menu|button|tab|sheet|filter|comment/.test(classHint) && normalized.length <= 30) return true;
    if (element.closest("button,[role='button'],[role='tab'],[role='menuitem']")) return true;
    if (lines.length > 4) return true;
    if (normalized.length <= 2 && /^[+\-*/%=<>.,;:!?()[\]{}|\\]$/.test(normalized)) return true;
    if (UI_NOISE_KEYWORDS.some((keyword) => keyword && normalized.includes(keyword))) return true;
    return false;
  }

  function scoreVisibleFormulaCandidate(element, rect, canvasRect, text) {
    let score = 0;
    const classHint = `${element.className || ""} ${element.id || ""} ${element.getAttribute("data-testid") || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
    if (/formula|fx|input|editor|cell|value/.test(classHint)) score += 30;
    if (canvasRect) {
      score += Math.max(0, 90 - Math.abs(canvasRect.top - rect.bottom));
      if (rect.left <= canvasRect.left + 80) score += 12;
      if (rect.right >= canvasRect.left + 260) score += 8;
    } else {
      score += Math.max(0, 80 - Math.abs(rect.top - 140));
    }
    if (rect.width >= 240) score += 10;
    if (text.length >= 4) score += 8;
    if (/[\u4e00-\u9fffA-Za-z0-9]/.test(text)) score += 10;
    return score;
  }

  function findBestFormulaEditor() {
    const seen = new Set();
    const candidates = [];

    FORMULA_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof Element)) return;
        const editable = resolveFormulaEditable(node);
        if (!(editable instanceof Element) || seen.has(editable)) return;
        seen.add(editable);
        candidates.push({ element: editable, score: scoreFormulaCandidate(editable) });
      });
    });

    document.querySelectorAll(EDITOR_SELECTOR).forEach((node) => {
      if (!(node instanceof Element) || seen.has(node)) return;
      if (!isLikelyFormulaBar(node)) return;
      seen.add(node);
      candidates.push({ element: node, score: scoreFormulaCandidate(node) });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].element : null;
  }

  function resolveFormulaEditable(node) {
    if (!(node instanceof Element)) return null;
    if (node.matches(EDITOR_SELECTOR)) return node;
    const child = node.querySelector(EDITOR_SELECTOR);
    return child instanceof Element ? child : null;
  }

  function scoreFormulaCandidate(element) {
    if (!(element instanceof Element)) return 0;
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (rect.top >= 0 && rect.top <= 320) score += 20;
    if (rect.width >= 240) score += 15;
    if (rect.width >= 500) score += 10;

    const classHint = `${element.className || ""} ${(element.closest("[class]") || {}).className || ""}`;
    const ariaLabel = element.getAttribute("aria-label") || "";
    const placeholder = element.getAttribute("placeholder") || "";
    const hint = `${classHint} ${ariaLabel} ${placeholder}`;
    if (/formula|fx|公式/i.test(hint)) score += 35;
    return score;
  }

  function isLikelyFormulaBar(element) {
    if (!(element instanceof Element)) return false;
    if (!isVisibleElement(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 220 || rect.top < 0 || rect.top > 340) return false;

    const classHint = `${element.className || ""} ${(element.closest("[class]") || {}).className || ""}`;
    const ariaLabel = element.getAttribute("aria-label") || "";
    const placeholder = element.getAttribute("placeholder") || "";
    const hasHint = /formula|fx|公式/i.test(`${classHint} ${ariaLabel} ${placeholder}`);
    if (!hasHint) return false;
    return scoreFormulaCandidate(element) >= 55;
  }

  function probeSelectedCellText(target) {
    const seen = new Set();
    const candidates = [];

    if (target instanceof Element) {
      const ownCell = closestWithinDepth(target, CELL_SELECTOR, MAX_SEARCH_DEPTH);
      if (ownCell instanceof Element) {
        seen.add(ownCell);
        candidates.push({ text: extractTextFromElement(ownCell, true), score: 80 });
      }
    }

    ACTIVE_CELL_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof Element) || seen.has(node)) return;
        seen.add(node);
        candidates.push({ text: extractTextFromElement(node, true), score: 70 });
      });
    });

    return pickBestCandidateText(candidates);
  }

  function pickBestCandidateText(candidates) {
    let bestText = "";
    let bestScore = -Infinity;
    candidates.forEach((candidate) => {
      const text = normalizeCellText(candidate.text);
      if (!text) return;
      const score = Number(candidate.score || 0) + Math.min(20, Math.floor(text.length / 40));
      if (score > bestScore) {
        bestScore = score;
        bestText = text;
      }
    });
    return bestText;
  }

  function evaluateCandidate(text, sourceKey, cellAddress) {
    if (!text) return { status: "reject", reason: "empty" };
    if (isBlockedText(text)) return { status: "blocked", reason: "blocked_text" };
    if (sourceKey && sourceKey.startsWith("formula") && isCurrentCellAddressToken(text, cellAddress)) return { status: "reject", reason: "cell_address_token" };
    if (!isUsefulText(text)) return { status: "reject", reason: "not_useful" };
    return { status: "success", reason: "ok" };
  }

  function refineFormulaCaptureEvaluation(session, sourceKey, text, evaluation) {
    if (!session || sourceKey !== "formula" || !evaluation || evaluation.status !== "success") return evaluation;

    const elapsed = elapsedMs(session);
    if (elapsed < FORMULA_CAPTURE_MIN_ACCEPT_MS) {
      return {
        status: "reject",
        reason: "formula_pending_sync",
        details: {
          elapsedMs: elapsed,
          minAcceptMs: FORMULA_CAPTURE_MIN_ACCEPT_MS
        }
      };
    }

    if (isLikelyPreviousCellFormulaText(session, text)) {
      const previousCellAddress = lastCaptureResult && lastCaptureResult.cellAddress ? lastCaptureResult.cellAddress : "";
      const currentCellAddress = session.cellAddress || "";
      if (elapsed >= FORMULA_SAME_TEXT_SETTLE_MS) {
        return {
          status: "success",
          reason: "accepted_same_text_after_settle",
          details: {
            elapsedMs: elapsed,
            settleMs: FORMULA_SAME_TEXT_SETTLE_MS,
            previousCellAddress,
            currentCellAddress
          }
        };
      }

      session.sawStalePreviousFormula = true;
      return {
        status: "reject",
        reason: "formula_matches_previous_cell",
        details: {
          elapsedMs: elapsed,
          settleMs: FORMULA_SAME_TEXT_SETTLE_MS,
          previousCellAddress,
          currentCellAddress
        }
      };
    }

    return evaluation;
  }

  function isLikelyPreviousCellFormulaText(session, text) {
    if (!lastCaptureResult || !text) return false;
    if (text !== lastCaptureResult.text) return false;
    const previousAddress = normalizeCellAddress(lastCaptureResult.cellAddress);
    const currentAddress = normalizeCellAddress(session && session.cellAddress);
    return Boolean(previousAddress && currentAddress && previousAddress !== currentAddress);
  }

  function rememberCaptureResult(text, cellAddress) {
    lastCaptureResult = {
      text: normalizeCellText(text),
      cellAddress: normalizeCellAddress(cellAddress)
    };
  }

  function isCurrentCellAddressToken(text, cellAddress) {
    const value = normalizeCellAddress(text);
    if (!value) return false;
    const current = normalizeCellAddress(cellAddress);
    return Boolean(current && value === current);
  }

  function isLikelyCellAddressToken(text) {
    const value = String(text || "").trim();
    return /^(?:\$?[A-Z]{1,4}\$?\d{1,7})(?::\$?[A-Z]{1,4}\$?\d{1,7})?$/.test(value);
  }

  function extractEditableText(element) {
    if (!(element instanceof Element)) return "";
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value ? element.value.trim() : "";
    }
    if (isContentEditableElement(element)) {
      return normalizeElementText(element.textContent || "");
    }
    return "";
  }

  function setEditorText(editor, text) {
    editor.focus();
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      setNativeInputValue(editor, text);
      try {
        editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      } catch (_) {}
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (isContentEditableElement(editor)) {
      selectAllContent(editor);
      if (isClearWriteText(text)) {
        clearContentEditable(editor);
        return;
      }
      try {
        editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertReplacementText", data: text }));
      } catch (_) {}
      const ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
      if (!ok) editor.textContent = text;
      try {
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, inputType: "insertText", data: text }));
      } catch (_) {}
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function clearContentEditable(editor) {
    try {
      editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward", data: null }));
    } catch (_) {}
    let cleared = false;
    try {
      cleared = typeof document.execCommand === "function" && document.execCommand("delete", false, null);
    } catch (_) {
      cleared = false;
    }
    if (!cleared || extractEditableText(editor)) {
      editor.textContent = "";
    }
    try {
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, inputType: "deleteContentBackward", data: null }));
    } catch (_) {}
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setEditorTextDetailed(editor, text) {
    try {
      const before = extractEditableText(editor);
      setEditorText(editor, text);
      const after = extractEditableText(editor);
      return {
        ok: true,
        reason: "ok",
        editor: describeElementForDebug(editor),
        beforeLength: before.length,
        beforeSample: sampleText(before),
        afterLength: after.length,
        afterSample: sampleText(after)
      };
    } catch (error) {
      return {
        ok: false,
        reason: error && error.message ? error.message : "set_text_failed",
        editor: describeElementForDebug(editor)
      };
    }
  }

  function commitEditor(editor) {
    if (editor && typeof editor.focus === "function") editor.focus();
    const init = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    editor.dispatchEvent(new KeyboardEvent("keydown", init));
    editor.dispatchEvent(new KeyboardEvent("keypress", init));
    editor.dispatchEvent(new KeyboardEvent("keyup", init));
    if (typeof editor.blur === "function") editor.blur();
  }

  function commitEditorDetailed(editor) {
    const dispatches = [];
    try {
      if (editor && typeof editor.focus === "function") editor.focus();
      const init = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
      ["keydown", "keypress", "keyup"].forEach((type) => {
        const dispatched = editor.dispatchEvent(new KeyboardEvent(type, init));
        dispatches.push({ type, dispatched });
      });
      let blurred = false;
      if (typeof editor.blur === "function") {
        editor.blur();
        blurred = true;
      }
      return { ok: true, reason: "ok", dispatches, blurred };
    } catch (error) {
      return {
        ok: false,
        reason: error && error.message ? error.message : "commit_failed",
        dispatches
      };
    }
  }

  async function runPasteWriteStrategy(text, context) {
    const normalizedTarget = normalizeCellText(text);
    const clipboardText = makeSingleCellClipboardText(text);
    const targets = collectPasteTargets(context);
    const dispatches = [];
    const observations = [];

    if (!targets.length) {
      return {
        ok: false,
        reason: "no_paste_target",
        observedFormula: "",
        clipboardTextSample: sampleText(clipboardText),
        dispatches,
        observations
      };
    }

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const dispatchResult = dispatchPasteEvent(target, clipboardText, text);
      dispatches.push({
        index,
        target: describeEventTargetForDebug(target),
        ...dispatchResult
      });

      const pasteVerification = await waitForFormulaMatch(normalizedTarget, [30, 70]);
      const observedFormula = pasteVerification.observedFormula;
      const observedActive = pasteVerification.observedActive;
      const matched = Boolean(pasteVerification.ok);
      observations.push({
        index,
        observedFormula,
        observedActive,
        matched,
        checks: pasteVerification.checks
      });

      if (matched) {
        return {
          ok: true,
          reason: "paste_persisted",
          observedFormula,
          clipboardTextSample: sampleText(clipboardText),
          dispatches,
          observations
        };
      }
    }

    return {
      ok: false,
      reason: "paste_not_persisted",
      observedFormula: observations.length ? observations[observations.length - 1].observedFormula : "",
      clipboardTextSample: sampleText(clipboardText),
      dispatches,
      observations
    };
  }

  async function waitForFormulaMatch(normalizedTarget, waits) {
    const checks = [];
    let observedFormula = "";
    let observedActive = "";

    for (let round = 0; round < waits.length; round += 1) {
      await sleep(waits[round]);
      observedFormula = normalizeCellText(probeFormulaBarText());
      observedActive = normalizeCellText(extractEditableText(resolveEditableRoot(getDeepActiveElement())));
      const matched = observedFormula === normalizedTarget;
      checks.push({
        round: round + 1,
        waitMs: waits[round],
        observedFormula,
        observedActive,
        matched
      });

      if (matched) {
        return {
          ok: true,
          reason: "formula_matches_target",
          observedFormula,
          observedActive,
          checks
        };
      }
    }

    return {
      ok: false,
      reason: "formula_not_matched",
      observedFormula,
      observedActive,
      checks
    };
  }

  async function runNativeClipboardPasteStrategy(text, context, options = {}) {
    const normalizedTarget = normalizeCellText(text);
    const clipboardText = makeSingleCellClipboardText(text);
    const actions = [];
    const observations = [];

    if (!clipboardText && normalizedTarget) {
      return {
        ok: false,
        reason: "clipboard_text_empty",
        observedFormula: "",
        actions,
        observations
      };
    }

    if (context) {
      const focusResult = focusCellByPointDetailed(context);
      actions.push({ action: "focus_cell", ...focusResult });
      if (!focusResult || !focusResult.ok) {
        return {
          ok: false,
          reason: "target_cell_focus_failed",
          observedFormula: normalizeCellText(probeFormulaBarText()),
          actions,
          observations
        };
      }
      await sleep(35);
    }

    const activeBeforePaste = resolveEditableRoot(getDeepActiveElement());
    actions.push({ action: "active_before_paste", target: describeElementForDebug(activeBeforePaste) });

    let clipboardWritten = Boolean(options && options.clipboardPrimed);
    if (clipboardWritten) {
      actions.push({ action: "use_prepared_clipboard", ok: true, textLength: clipboardText.length });
    } else {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(clipboardText);
          clipboardWritten = true;
          actions.push({ action: "navigator_clipboard_write_text", ok: true, textLength: clipboardText.length });
        } else {
          actions.push({ action: "navigator_clipboard_write_text", ok: false, reason: "api_missing" });
        }
      } catch (error) {
        actions.push({
          action: "navigator_clipboard_write_text",
          ok: false,
          reason: error && error.message ? error.message : "clipboard_write_failed"
        });
      }
    }

    if (!clipboardWritten) {
      return {
        ok: false,
        reason: "clipboard_write_failed",
        observedFormula: normalizeCellText(probeFormulaBarText()),
        actions,
        observations
      };
    }

    const pasteTargets = collectNativePasteCommandTargets(context);
    for (let index = 0; index < pasteTargets.length; index += 1) {
      const target = pasteTargets[index];
      const targetDescription = describeEventTargetForDebug(target);
      try {
        if (target instanceof Element && typeof target.focus === "function") target.focus();
      } catch (_) {}

      let execResult = false;
      let execError = "";
      try {
        execResult = typeof document.execCommand === "function" && document.execCommand("paste");
      } catch (error) {
        execError = error && error.message ? error.message : "exec_command_paste_failed";
      }

      const keyDispatch = dispatchPasteShortcut(target);
      actions.push({
        action: "native_paste_command",
        index,
        target: targetDescription,
        execResult,
        execError,
        keyDispatch
      });

      await sleep(140);
      const observedFormula = normalizeCellText(probeFormulaBarText());
      const observedActive = normalizeCellText(extractEditableText(resolveEditableRoot(getDeepActiveElement())));
      const matched = observedFormula === normalizedTarget;
      observations.push({
        index,
        observedFormula,
        observedActive,
        matched
      });

      if (matched) {
        return {
          ok: true,
          reason: "native_clipboard_paste_persisted",
          observedFormula,
          actions,
          observations
        };
      }
    }

    const settleWaits = [240, 520, 900, 1400];
    for (let round = 0; round < settleWaits.length; round += 1) {
      await sleep(settleWaits[round]);
      const observedFormula = normalizeCellText(probeFormulaBarText());
      const observedActive = normalizeCellText(extractEditableText(resolveEditableRoot(getDeepActiveElement())));
      const matched = observedFormula === normalizedTarget;
      observations.push({
        index: `settle-${round + 1}`,
        waitMs: settleWaits[round],
        observedFormula,
        observedActive,
        matched
      });

      if (matched) {
        return {
          ok: true,
          reason: "native_clipboard_paste_persisted_after_settle",
          observedFormula,
          actions,
          observations
        };
      }
    }

    return {
      ok: false,
      reason: "native_clipboard_paste_not_persisted",
      observedFormula: observations.length ? observations[observations.length - 1].observedFormula : normalizeCellText(probeFormulaBarText()),
      actions,
      observations
    };
  }

  async function runClearCellStrategy(context) {
    const actions = [];
    const observations = [];

    if (!context) {
      return {
        ok: false,
        reason: "missing_cell_context",
        observedFormula: normalizeCellText(probeFormulaBarText()),
        actions,
        observations
      };
    }

    const directClear = await tryClearByKeyTargets(context, actions, observations, "direct_clear_key");
    if (directClear) return directClear;

    const focusResult = focusCellByPointDetailed(context);
    actions.push({ action: "focus_cell_for_retry", ...focusResult });
    if (focusResult && focusResult.ok) {
      await sleep(35);
      const focusedClear = await tryClearByKeyTargets(context, actions, observations, "focused_clear_key");
      if (focusedClear) return focusedClear;
    }

    const editorSelection = findWriteTargetEditorDetailed(context);
    if (editorSelection && editorSelection.editor) {
      const beforeText = extractEditableText(editorSelection.editor);
      const setResult = setEditorTextDetailed(editorSelection.editor, "");
      const commitResult = commitEditorDetailed(editorSelection.editor);
      actions.push({
        action: "clear_editor",
        setResult,
        commitResult,
        editor: describeElementForDebug(editorSelection.editor)
      });
      const verified = beforeText ? await verifyWritePersisted("", context, editorSelection.editor) : null;
      observations.push({
        action: "verify_editor_clear",
        ok: Boolean(verified && verified.ok),
        skipped: !beforeText,
        details: verified || { reason: "skip_empty_editor_verification" }
      });
      if (verified && verified.ok) {
        return {
          ok: true,
          reason: "editor_clear_persisted",
          observedFormula: verified.observedFormula || "",
          actions,
          observations
        };
      }
    }

    return {
      ok: false,
      reason: "clear_not_persisted",
      observedFormula: observations.length ? observations[observations.length - 1].observedFormula : normalizeCellText(probeFormulaBarText()),
      actions,
      observations
    };
  }

  async function tryClearByKeyTargets(context, actions, observations, actionName) {
    const targets = collectClearCommandTargets(context);
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      for (const key of ["Delete"]) {
        const dispatch = dispatchClearKey(target, key);
        actions.push({
          action: actionName,
          index,
          key,
          target: describeEventTargetForDebug(target),
          dispatch
        });

        const clearVerification = await verifyClearStably();
        const observedFormula = clearVerification.observedFormula;
        const observedActive = clearVerification.observedActive;
        const matched = Boolean(clearVerification && clearVerification.ok);
        observations.push({
          index,
          key,
          observedFormula,
          observedActive,
          clearVerification,
          matched
        });

        if (matched) {
          return {
            ok: true,
            reason: "clear_key_persisted",
            observedFormula,
            actions,
            observations
          };
        }
      }
    }

    return null;
  }

  function collectClearCommandTargets(context) {
    const targets = [];
    const add = (target) => {
      if (!target) return;
      if (!(target instanceof EventTarget)) return;
      if (targets.includes(target)) return;
      targets.push(target);
    };

    if (context && Number.isFinite(context.x) && Number.isFinite(context.y)) {
      const atPoint = document.elementFromPoint(context.x, context.y);
      add(atPoint);
      if (atPoint instanceof Element) {
        add(atPoint.closest("canvas.faster-single-canvas"));
      }
    }

    add(document.querySelector("canvas.faster-single-canvas"));
    add(resolveEditableRoot(getDeepActiveElement()));
    add(document.activeElement);
    add(document.body);
    add(document);
    add(window);
    return targets;
  }

  function dispatchClearKey(target, key) {
    const dispatches = [];
    const eventTarget = target instanceof EventTarget ? target : document;
    try {
      if (target instanceof Element && typeof target.focus === "function") target.focus();
    } catch (_) {}
    const isDelete = key === "Delete";
    const init = {
      bubbles: true,
      cancelable: true,
      key,
      code: key,
      keyCode: isDelete ? 46 : 8,
      which: isDelete ? 46 : 8
    };

    ["keydown", "keypress", "keyup"].forEach((type) => {
      try {
        const dispatched = eventTarget.dispatchEvent(new KeyboardEvent(type, init));
        dispatches.push({ type, dispatched });
      } catch (error) {
        dispatches.push({ type, dispatched: false, error: error && error.message ? error.message : "dispatch_failed" });
      }
    });

    return dispatches;
  }

  async function verifyClearStably() {
    const actions = [];
    const waits = [45, 90];
    let observedFormula = "";
    let observedActive = "";

    for (let index = 0; index < waits.length; index += 1) {
      await sleep(waits[index]);
      observedFormula = normalizeCellText(probeFormulaBarText());
      observedActive = normalizeCellText(extractEditableText(resolveEditableRoot(getDeepActiveElement())));
      actions.push({
        action: "stable_read",
        round: index + 1,
        waitMs: waits[index],
        observedFormula,
        observedActive
      });

      if (observedFormula !== "") {
        return {
          ok: false,
          reason: "formula_not_empty",
          observedFormula,
          observedActive,
          actions
        };
      }
    }

    return {
      ok: true,
      reason: "formula_stably_empty",
      observedFormula,
      observedActive,
      actions
    };
  }

  function collectNativePasteCommandTargets(context) {
    const targets = [];
    const add = (target) => {
      if (!target) return;
      if (!(target instanceof EventTarget)) return;
      if (targets.includes(target)) return;
      targets.push(target);
    };

    add(resolveEditableRoot(getDeepActiveElement()));

    if (context && Number.isFinite(context.x) && Number.isFinite(context.y)) {
      const atPoint = document.elementFromPoint(context.x, context.y);
      if (atPoint instanceof Element) {
        add(atPoint.closest("canvas.faster-single-canvas"));
      }
      add(atPoint);
    }

    add(document.activeElement);
    add(document.body);
    add(document);
    add(window);
    return targets;
  }

  function dispatchPasteShortcut(target) {
    const dispatches = [];
    const eventTarget = target instanceof EventTarget ? target : document;
    const init = {
      bubbles: true,
      cancelable: true,
      key: "v",
      code: "KeyV",
      keyCode: 86,
      which: 86,
      ctrlKey: !isMacPlatform(),
      metaKey: isMacPlatform()
    };

    ["keydown", "keypress", "keyup"].forEach((type) => {
      try {
        const dispatched = eventTarget.dispatchEvent(new KeyboardEvent(type, init));
        dispatches.push({ type, dispatched });
      } catch (error) {
        dispatches.push({ type, dispatched: false, error: error && error.message ? error.message : "dispatch_failed" });
      }
    });

    return dispatches;
  }

  function isMacPlatform() {
    return /mac/i.test(navigator.platform || navigator.userAgent || "");
  }

  function isNativePasteLikelyDispatched(result) {
    if (!result || result.ok) return false;
    if (result.reason !== "native_clipboard_paste_not_persisted") return false;

    const actions = Array.isArray(result.actions) ? result.actions : [];
    const clipboardReady = actions.some((action) => {
      return action &&
        (action.action === "use_prepared_clipboard" || action.action === "navigator_clipboard_write_text") &&
        action.ok === true;
    });
    if (!clipboardReady) return false;

    return actions.some((action) => {
      if (!action || action.action !== "native_paste_command") return false;
      if (action.execResult === true) return true;
      const dispatches = Array.isArray(action.keyDispatch) ? action.keyDispatch : [];
      const down = dispatches.find((item) => item && item.type === "keydown");
      const up = dispatches.find((item) => item && item.type === "keyup");
      return Boolean(down && down.dispatched !== false && up && up.dispatched !== false);
    });
  }

  function collectPasteTargets(context) {
    const targets = [];
    const add = (target) => {
      if (!target) return;
      if (!(target instanceof EventTarget)) return;
      if (targets.includes(target)) return;
      targets.push(target);
    };

    const active = resolveEditableRoot(getDeepActiveElement());
    add(active);

    if (context && Number.isFinite(context.x) && Number.isFinite(context.y)) {
      const atPoint = document.elementFromPoint(context.x, context.y);
      add(atPoint);
      if (atPoint instanceof Element) {
        add(atPoint.closest("canvas.faster-single-canvas"));
      }
    }

    add(document.querySelector("canvas.faster-single-canvas"));
    add(document.activeElement);
    add(document.body);
    add(document);
    add(window);
    return targets;
  }

  function dispatchPasteEvent(target, clipboardText, rawText) {
    try {
      const data = createClipboardData(clipboardText, rawText);
      const event = createPasteEvent(data);
      const dispatched = target.dispatchEvent(event);
      return {
        ok: true,
        reason: "paste_event_dispatched",
        dispatched,
        defaultPrevented: Boolean(event.defaultPrevented),
        dataTypes: data && data.types ? Array.from(data.types) : []
      };
    } catch (error) {
      return {
        ok: false,
        reason: error && error.message ? error.message : "paste_event_failed",
        dispatched: false,
        defaultPrevented: false,
        dataTypes: []
      };
    }
  }

  function createClipboardData(clipboardText, rawText) {
    const data = new DataTransfer();
    data.setData("text/plain", clipboardText);
    data.setData("text/html", makeSingleCellClipboardHtml(rawText));
    return data;
  }

  function createPasteEvent(clipboardData) {
    try {
      return new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData
      });
    } catch (_) {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: clipboardData,
        configurable: true
      });
      return event;
    }
  }

  function makeSingleCellClipboardText(text) {
    const normalized = normalizeWriteText(text);
    if (!/[\t\n"]/.test(normalized)) return normalized;
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  function makeSingleCellClipboardHtml(text) {
    return [
      "<html><body><table><tbody><tr><td>",
      escapeHtmlForClipboard(normalizeWriteText(text)).replace(/\n/g, "<br>"),
      "</td></tr></tbody></table></body></html>"
    ].join("");
  }

  function escapeHtmlForClipboard(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function describeEventTargetForDebug(target) {
    if (target instanceof Element) return describeElementForDebug(target);
    if (target === document) return { tag: "#document" };
    if (target === window) return { tag: "#window" };
    return { tag: "unknown" };
  }

  async function verifyWritePersisted(targetText, context, editor) {
    const normalizedTarget = normalizeCellText(targetText);
    const checkpoints = [35, 90, 180, 360, 700];
    const observations = [];

    for (let i = 0; i < checkpoints.length; i += 1) {
      await sleep(checkpoints[i]);

      const observedFormula = normalizeCellText(probeFormulaBarText());
      const observedEditor = normalizeCellText(extractEditableText(editor));
      const observedActive = normalizeCellText(extractEditableText(resolveEditableRoot(getDeepActiveElement())));

      const matched = observedFormula === normalizedTarget;
      observations.push({
        round: i + 1,
        waitMs: checkpoints[i],
        observedFormula,
        observedEditor,
        observedActive,
        matched
      });

      if (matched) {
        return {
          ok: true,
          reason: "formula_matches_target",
          observedFormula,
          observations
        };
      }

      if (i === 0) {
        const forced = runForceCommitActions(context);
        observations.push({
          round: i + 1,
          action: "force_commit_actions",
          details: forced
        });
      }
    }

    return {
      ok: false,
      reason: "formula_not_updated",
      observedFormula: observations.length ? (observations[observations.length - 1].observedFormula || "") : "",
      observations
    };
  }

  async function verifyNativePasteResult(targetText, context, options) {
    const focus = options && options.skipFocus
      ? { ok: true, reason: "skip_focus_after_native_paste" }
      : (context ? focusCellByPointDetailed(context) : { ok: false, reason: "missing_cell_context" });
    const normalizedTarget = normalizeCellText(targetText);
    const observations = [];
    const waits = [35, 90, 180, 320];

    for (let i = 0; i < waits.length; i += 1) {
      await sleep(waits[i]);
      const observedFormula = normalizeCellText(probeFormulaBarText());
      const observedActive = normalizeCellText(extractEditableText(resolveEditableRoot(getDeepActiveElement())));
      const matched = observedFormula === normalizedTarget;
      observations.push({
        round: i + 1,
        waitMs: waits[i],
        observedFormula,
        observedActive,
        matched
      });

      if (matched) {
        emitCellSelected(targetText, "原生粘贴写回", context);
        return {
          ok: true,
          reason: "native_paste_persisted",
          focus,
          observedFormula,
          observations
        };
      }
    }

    return {
      ok: false,
      reason: "native_paste_not_verified",
      focus,
      observedFormula: observations.length ? observations[observations.length - 1].observedFormula : "",
      observations
    };
  }

  function runForceCommitActions(context) {
    const actions = [];
    const active = resolveEditableRoot(getDeepActiveElement());

    if (active instanceof Element) {
      try {
        active.focus();
        actions.push({ action: "focus_active", ok: true });
      } catch (error) {
        actions.push({ action: "focus_active", ok: false, error: error && error.message ? error.message : "focus_failed" });
      }

      try {
        const init = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
        const down = active.dispatchEvent(new KeyboardEvent("keydown", init));
        const press = active.dispatchEvent(new KeyboardEvent("keypress", init));
        const up = active.dispatchEvent(new KeyboardEvent("keyup", init));
        actions.push({ action: "dispatch_enter_active", ok: true, down, press, up });
      } catch (error) {
        actions.push({ action: "dispatch_enter_active", ok: false, error: error && error.message ? error.message : "dispatch_failed" });
      }
    }

    actions.push({ action: "skip_formula_commit_button", ok: true, reason: "in_cell_only_mode" });

    if (context && Number.isFinite(context.x) && Number.isFinite(context.y)) {
      const nx = Math.max(8, Math.min(window.innerWidth - 8, context.x + 28));
      const ny = Math.max(8, Math.min(window.innerHeight - 8, context.y + 26));
      const target = document.elementFromPoint(nx, ny);
      if (target instanceof Element) {
        try {
          ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
            target.dispatchEvent(new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: nx,
              clientY: ny,
              button: 0
            }));
          });
          actions.push({ action: "click_nearby_cell", ok: true, point: { x: nx, y: ny }, target: describeElementForDebug(target) });
        } catch (error) {
          actions.push({ action: "click_nearby_cell", ok: false, error: error && error.message ? error.message : "nearby_click_failed" });
        }
      } else {
        actions.push({ action: "click_nearby_cell", ok: false, reason: "nearby_target_missing" });
      }
    }

    return actions;
  }

  

  function setNativeInputValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function selectAllContent(element) {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function focusCellByPoint(context) {
    if (!context) return;
    const x = context.x;
    const y = context.y;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return;
    const target = document.elementFromPoint(x, y);
    if (!(target instanceof Element)) return;
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0
      }));
    });
  }

  function resolveCellAddress(target, context) {
    const candidates = [];
    const add = (element) => {
      if (!(element instanceof Element) || candidates.includes(element)) return;
      candidates.push(element);
      const cell = closestWithinDepth(element, CELL_SELECTOR, MAX_SEARCH_DEPTH);
      if (cell instanceof Element && !candidates.includes(cell)) candidates.push(cell);
    };

    add(target);

    const normalizedContext = normalizeCellContext(context);
    if (normalizedContext) {
      const pointTarget = document.elementFromPoint(normalizedContext.x, normalizedContext.y);
      add(pointTarget);
    }

    add(findCurrentActiveCellElement());
    add(getDeepActiveElement());

    for (const element of candidates) {
      const address = extractCellAddressFromElement(element);
      if (address) return address;
    }

    const uiAddress = findCellAddressFromVisibleUi(normalizedContext);
    if (uiAddress) return uiAddress;

    return "";
  }

  function extractCellAddressFromElement(element) {
    if (!(element instanceof Element)) return "";

    let node = element;
    let depth = 0;
    while (node && node !== document.body && depth < MAX_SEARCH_DEPTH) {
      const direct = extractCellAddressFromAttributes(node);
      if (direct) return direct;
      node = node.parentElement;
      depth += 1;
    }

    return "";
  }

  function extractCellAddressFromAttributes(element) {
    const addressAttrs = [
      "data-cell-address",
      "data-address",
      "data-cell",
      "data-cell-id",
      "data-coord",
      "data-coordinate",
      "aria-label",
      "title"
    ];

    for (const attr of addressAttrs) {
      const address = normalizeCellAddress(element.getAttribute(attr));
      if (address) return address;
    }

    for (const attr of Array.from(element.attributes || [])) {
      if (!/^(data-|aria-|id$|title$|name$)/i.test(attr.name)) continue;
      const address = normalizeCellAddress(attr.value);
      if (address) return address;
    }

    const rowInfo = readNumericAttribute(element, [
      "data-row-index",
      "row-index",
      "aria-rowindex",
      "data-row",
      "row"
    ]);
    const colInfo = readColumnAttribute(element, [
      "data-col-index",
      "data-column-index",
      "col-index",
      "aria-colindex",
      "data-col",
      "data-column",
      "col"
    ]);

    if (rowInfo && colInfo) {
      const row = rowInfo.zeroBased ? rowInfo.value + 1 : rowInfo.value;
      const col = colInfo.letter || indexToColumnName(colInfo.zeroBased ? colInfo.value + 1 : colInfo.value);
      if (row > 0 && col) return `${col}${row}`;
    }

    return "";
  }

  function findCellAddressFromVisibleUi(context) {
    const canvasRect = getSheetCanvasRect(context);
    const selectors = [
      "input",
      "textarea",
      "[contenteditable]:not([contenteditable='false'])",
      "[role='textbox']",
      "[role='combobox']",
      "[aria-label]",
      "[title]",
      "[class*='formula' i]",
      "[class*='name' i]",
      "[class*='address' i]",
      "[class*='coord' i]",
      "[class*='range' i]",
      "[class*='selection' i]",
      "[data-testid*='formula' i]",
      "[data-testid*='name' i]",
      "[data-testid*='address' i]",
      "[data-testid*='range' i]",
      "[data-testid*='selection' i]"
    ];
    const seen = new Set();
    const candidates = [];

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof Element) || seen.has(node) || !isVisibleElement(node)) return;
        seen.add(node);
        const rect = node.getBoundingClientRect();
        if (!isLikelyAddressUiRect(rect, canvasRect)) return;

        const values = collectAddressCandidateTexts(node);
        values.forEach((value) => {
          const address = normalizeCellAddress(value);
          if (!address) return;
          candidates.push({
            address,
            score: scoreAddressUiCandidate(node, rect, canvasRect, value)
          });
        });
      });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].address : "";
  }

  function collectAddressCandidateTexts(element) {
    const values = [];
    const add = (value) => {
      const text = String(value || "").trim();
      if (!text || text.length > 40) return;
      values.push(text);
    };

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) add(element.value);
    if (isContentEditableElement(element)) add(element.textContent || "");
    add(element.getAttribute("aria-label"));
    add(element.getAttribute("title"));
    add(element.getAttribute("value"));

    const visibleText = normalizeElementText(element.textContent || "");
    if (visibleText && visibleText.length <= 40) add(visibleText);

    return values;
  }

  function isLikelyAddressUiRect(rect, canvasRect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    if (rect.width > 220 || rect.height > 60) return false;
    if (canvasRect) {
      const nearSheetTop = rect.top >= canvasRect.top - 120 && rect.top <= canvasRect.top + 80;
      const nearSheetLeft = rect.left >= canvasRect.left - 180 && rect.left <= canvasRect.right;
      if (nearSheetTop && nearSheetLeft) return true;
    }
    return rect.top >= 0 && rect.top <= 360;
  }

  function scoreAddressUiCandidate(element, rect, canvasRect, rawValue) {
    let score = 0;
    const value = String(rawValue || "").trim();
    const own = `${element.className || ""} ${element.id || ""} ${element.getAttribute("data-testid") || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
    if (/name|address|coord|range|selection|cell/.test(own)) score += 35;
    if (/formula|fx/.test(own)) score += 15;
    if (/^\$?[A-Z]{1,4}\$?\d{1,7}$/.test(value.toUpperCase())) score += 30;
    if (/^\$?[A-Z]{1,4}\$?\d{1,7}\s*:\s*\$?[A-Z]{1,4}\$?\d{1,7}$/.test(value.toUpperCase())) score += 24;
    if (rect.width <= 120) score += 8;
    if (canvasRect) {
      score += Math.max(0, 80 - Math.abs(rect.top - canvasRect.top));
      if (rect.left <= canvasRect.left + 240) score += 10;
    } else {
      score += Math.max(0, 60 - rect.top / 4);
    }
    return score;
  }

  function readNumericAttribute(element, attrs) {
    for (const attr of attrs) {
      const raw = element.getAttribute(attr);
      if (raw == null || raw === "") continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) continue;
      return { value, zeroBased: isZeroBasedIndexAttribute(attr, value) };
    }
    return null;
  }

  function readColumnAttribute(element, attrs) {
    for (const attr of attrs) {
      const raw = element.getAttribute(attr);
      if (raw == null || raw === "") continue;
      const letter = String(raw).trim().toUpperCase();
      if (/^[A-Z]{1,4}$/.test(letter)) return { letter, value: 0, zeroBased: false };
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) continue;
      return { letter: "", value, zeroBased: isZeroBasedIndexAttribute(attr, value) };
    }
    return null;
  }

  function normalizeCellAddress(value) {
    const text = String(value || "").trim().toUpperCase();
    if (!text) return "";
    const match = text.match(/(?:^|[^A-Z0-9])\$?([A-Z]{1,4})\$?(\d{1,7})(?=$|[^A-Z0-9])/);
    return match ? `${match[1]}${match[2]}` : "";
  }

  function isZeroBasedIndexAttribute(attr, value) {
    return (!/^aria-/i.test(attr) && /index/i.test(attr)) || value === 0;
  }

  function indexToColumnName(index) {
    let value = Number(index);
    if (!Number.isInteger(value) || value <= 0) return "";
    let name = "";
    while (value > 0) {
      value -= 1;
      name = String.fromCharCode(65 + (value % 26)) + name;
      value = Math.floor(value / 26);
    }
    return name;
  }

  function emitCellSelected(text, source, context, cellAddress) {
    const normalized = normalizeCellText(text);
    const cellContext = normalizeCellContext(context) || lastCellContext;
    lastCellContext = cellContext || lastCellContext;
    const resolvedAddress = resolveCellAddress(null, cellContext);
    sendMessage({
      type: "FZ_CELL_SELECTED",
      text: normalized,
      source,
      pageTitle: document.title,
      pageUrl: location.href,
      cellContext: cellContext || null,
      cellAddress: resolvedAddress || normalizeCellAddress(cellAddress)
    });
  }

  function finalizeSession(session, status, chosenSource) {
    if (!isSessionActive(session)) return;
    session.state = status;
    sendMessage({
      type: "FZ_CAPTURE_DEBUG",
      debug: {
        sessionId: session.id,
        url: session.url,
        clickTarget: session.clickTarget,
        startedAt: session.startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Math.max(0, Math.round(performance.now() - session.startedMs)),
        attempts: session.attempts,
        finalResult: { status, chosenSource: chosenSource || "" }
      }
    });
    if (currentSession && currentSession.id === session.id) currentSession = null;
  }

  function emitCaptureError(error, target) {
    const session = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      url: location.href,
      startedAt: new Date().toISOString(),
      startedMs: performance.now(),
      clickTarget: describeClickTarget(target || document.body, null),
      attempts: [],
      state: "running"
    };
    pushAttempt(session, {
      step: 1,
      source: "异常",
      elapsedMs: 0,
      hit: false,
      reason: error && error.message ? error.message : "unknown_error",
      candidateLength: 0,
      candidateSample: ""
    });
    currentSession = session;
    finalizeSession(session, "error", "");
    sendMessage({ type: "FZ_CAPTURE_ERROR", error: serializeError(error) });
  }

  function cancelSession() {
    if (!currentSession) return;
    currentSession.state = "cancelled";
    currentSession = null;
  }

  function extractTextFromElement(element, allowVisibleText) {
    if (!(element instanceof Element)) return "";
    const attrs = ["data-value", "data-content", "data-text", "data-cell-value", "data-raw-value", "title", "aria-label", "value"];
    for (const attr of attrs) {
      const raw = element.getAttribute(attr);
      if (raw && raw.trim()) return raw.trim();
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.value && element.value.trim()) return element.value.trim();
    }
    if (isContentEditableElement(element)) {
      const text = normalizeElementText(element.textContent || "");
      if (text) return text;
    }
    if (allowVisibleText && isVisibleElement(element)) {
      const text = normalizeElementText(element.innerText || element.textContent || "");
      if (text) return text;
    }
    return "";
  }

  function isUsefulText(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    if (text.length > 50000) return false;
    if (/^(true|false|button|gridcell)$/i.test(text)) return false;
    if (isLikelyUiNoise(text)) return false;
    return true;
  }

  function isLikelyUiNoise(text) {
    const normalized = String(text || "").trim();
    if (!normalized) return false;
    const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
    const lower = normalized.toLowerCase();
    const keywordHits = UI_NOISE_KEYWORDS.reduce((count, keyword) => count + (lower.includes(keyword.toLowerCase()) ? 1 : 0), 0);
    const tabHits = (normalized.match(/\bSheet\d+\b/g) || []).length;
    const shortLineCount = lines.filter((line) => line.length <= 10).length;
    const shortRatio = lines.length ? shortLineCount / lines.length : 0;
    if (keywordHits >= 4 && lines.length >= 8) return true;
    if (tabHits >= 3) return true;
    if (lines.length >= 12 && shortRatio > 0.65 && keywordHits >= 2) return true;
    return false;
  }

  function isBlockedText(value) {
    const text = String(value || "").trim();
    return BLOCKED_TEXT_PATTERNS.some((pattern) => pattern.test(text));
  }

  function normalizeCellText(value) {
    let text = String(value || "");
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = text.replace(/\n+$/, "").trim();
    return unquoteSpreadsheetCell(text);
  }

  function normalizeWriteText(value) {
    return String(value == null ? "" : value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  function isClearWriteText(value) {
    return normalizeWriteText(value) === "";
  }

  function normalizeCellContext(context) {
    if (!context || typeof context !== "object") return null;
    const x = Number(context.x);
    const y = Number(context.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function unquoteSpreadsheetCell(value) {
    const text = String(value || "").trim();
    if (text.length < 2) return text;
    const pairs = [
      ['"', '"'],
      ["'", "'"],
      ["“", "”"],
      ["‘", "’"],
      ["「", "」"],
      ["『", "』"]
    ];
    for (const [left, right] of pairs) {
      if (text.startsWith(left) && text.endsWith(right)) {
        const inner = text.slice(left.length, -right.length);
        return left === '"' ? inner.replace(/""/g, '"') : inner;
      }
    }
    return text;
  }

  function normalizeElementText(text) {
    return String(text || "").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function describeClickTarget(target, event) {
    if (!(target instanceof Element)) return { tag: "unknown", id: "", className: "", role: "", ariaLabel: "", x: 0, y: 0 };
    const cls = typeof target.className === "string" ? target.className : "";
    return {
      tag: target.tagName.toLowerCase(),
      id: target.id || "",
      className: cls.slice(0, 120),
      role: target.getAttribute("role") || "",
      ariaLabel: (target.getAttribute("aria-label") || "").slice(0, 120),
      x: event && typeof event.clientX === "number" ? Math.round(event.clientX) : 0,
      y: event && typeof event.clientY === "number" ? Math.round(event.clientY) : 0
    };
  }

  function pushAttempt(session, attempt) {
    if (!session || !Array.isArray(session.attempts)) return;
    session.attempts.push(attempt);
  }

  function elapsedMs(session) {
    return Math.max(0, Math.round(performance.now() - session.startedMs));
  }

  function sampleText(text) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    return normalized.slice(0, 140);
  }

  function safelyRunProbe(fn) {
    try {
      const value = fn();
      return typeof value === "string" ? value : "";
    } catch (_) {
      return "";
    }
  }

  function getDeepActiveElement() {
    let current = document.activeElement;
    while (current && current.shadowRoot && current.shadowRoot.activeElement) {
      current = current.shadowRoot.activeElement;
    }
    return current;
  }

  function closestWithinDepth(element, selector, maxDepth) {
    let node = element;
    let depth = 0;
    while (node && node !== document.body && depth < maxDepth) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
      depth += 1;
    }
    return null;
  }

  function isContentEditableElement(element) {
    if (!(element instanceof Element)) return false;
    if (element.isContentEditable) return true;
    const attr = element.getAttribute("contenteditable");
    return attr != null && String(attr).toLowerCase() !== "false";
  }

  function isEditableElement(element) {
    if (!(element instanceof Element)) return false;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return true;
    if (isContentEditableElement(element)) return true;
    return (element.getAttribute("role") || "").toLowerCase() === "textbox";
  }

  function resolveEditableRoot(element) {
    if (!(element instanceof Element)) return null;
    let node = element;
    let depth = 0;
    while (node && node.parentElement && depth < 8) {
      if (!isEditableElement(node.parentElement)) break;
      node = node.parentElement;
      depth += 1;
    }
    return node;
  }

  function isElementNearPoint(element, context, thresholdPx) {
    if (!(element instanceof Element) || !context) return false;
    const x = Number(context.x);
    const y = Number(context.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = cx - x;
    const dy = cy - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance <= Math.max(60, Number(thresholdPx || 180));
  }

  function isFormulaEditorElement(element) {
    if (!(element instanceof Element)) return false;
    const own = `${element.className || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""}`;
    if (/formula|formulabar|fx|公式/i.test(own)) return true;
    const host = element.closest("[class*='formula' i], [data-testid*='formula' i], [aria-label*='公式' i], [placeholder*='公式' i]");
    return host instanceof Element;
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0;
  }

  function isSessionActive(session) {
    return Boolean(session && currentSession && currentSession.id === session.id && session.state === "running");
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function sendMessage(payload) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      const result = chrome.runtime.sendMessage(payload);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {}
  }

  function serializeError(error) {
    return {
      name: error && error.name ? error.name : "Error",
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack).slice(0, 1200) : ""
    };
  }
})();
