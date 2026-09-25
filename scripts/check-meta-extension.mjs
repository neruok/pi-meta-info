#!/usr/bin/env node
// Checks the meta Pi extension in meta.ts
// (REQ-TOOL-1..REQ-TOOL-5, REQ-DOC-1, AC-15, AC-18).
//
// The extension is copied into a temporary directory beside node_modules
// symlinks to the installed Pi package, because the profile directory itself
// has no node_modules, so the extension's bare imports cannot resolve in
// place. The copy is byte-identical, and nothing here executes the extension
// against a live session or opens credentials.
//
// Requires Node with TypeScript type stripping (Node >= 22.18 or 23); Node 24
// needs no flag. Pass the Pi package directory as argv[2] to override.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const repoDir = fileURLToPath(new URL("../", import.meta.url));
const packageDir = resolve(
  process.argv[2] ??
    join(
      execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim(),
      "@earendil-works/pi-coding-agent",
    ),
);

const scratch = mkdtempSync(join(tmpdir(), "pi-meta-info-ext-"));
const results = [];

async function check(ac, name, fn) {
  try {
    await fn();
    results.push({ ac, name, ok: true, reason: "" });
  } catch (error) {
    results.push({ ac, name, ok: false, reason: error?.message ?? String(error) });
  }
}

try {
  const modules = join(scratch, "node_modules");
  mkdirSync(join(modules, "@earendil-works"), { recursive: true });
  symlinkSync(packageDir, join(modules, "@earendil-works", "pi-coding-agent"), "dir");
  symlinkSync(join(packageDir, "node_modules", "typebox"), join(modules, "typebox"), "dir");
  symlinkSync(join(packageDir, "node_modules", "@earendil-works", "pi-ai"), join(modules, "@earendil-works", "pi-ai"), "dir");
  mkdirSync(join(scratch, "lib", "meta"), { recursive: true });
  for (const file of readdirSync(join(repoDir, "lib", "meta"))) {
    copyFileSync(
      join(repoDir, "lib", "meta", file),
      join(scratch, "lib", "meta", file),
    );
  }
  const extensionPath = join(scratch, "meta.ts");
  copyFileSync(join(repoDir, "meta.ts"), extensionPath);

  // Pi's own preflight validator, resolved through the scratch node_modules so
  // the bare specifier matches the one the copied extension uses.
  const validationLoader = join(scratch, "pi-validation.mjs");
  writeFileSync(validationLoader, 'export { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";\n');

  const extension = (await import(pathToFileURL(extensionPath).href)).default;
  const tools = [];
  const handlers = new Map();
  extension({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.push(tool),
    registerCommand: () => {},
  });
  const tool = tools[0];

  const workspaceRoot = mkdtempSync(join(scratch, "workspace-"));
  const ctx = { cwd: workspaceRoot, sessionManager: { getSessionId: () => "session-ext" } };
  const invoke = (params) => tool.execute("call-1", params, undefined, undefined, ctx);

  await check("AC-15", "the extension registers exactly one tool named meta", () => {
    assert.equal(tools.length, 1, "one tool is registered");
    assert.equal(tool.name, "meta");
    for (const name of ["read", "write", "edit", "grep", "find", "ls", "bash", "powershell", "meta-search", "meta-tags"]) {
      assert.ok(!tools.some((entry) => entry.name === name), `does not register ${name}`);
    }
  });

  await check("REQ-TOOL-3", "the extension installs no note-carrying hook", () => {
    for (const name of ["context", "before_agent_start", "before_provider_request"]) {
      assert.equal(handlers.has(name), false, `no ${name} handler`);
    }
  });

  await check("AC-1", "set and get round-trip through the tool boundary", async () => {
    writeFileSync(join(workspaceRoot, "a.txt"), "Parses job input.");
    const set = await invoke({ action: "set", path: "a.txt", tag: "summary", note: "Parses job input." });
    assert.equal(set.details.error, null, JSON.stringify(set.details.error));
    assert.equal(set.details.records[0].staleness, "FRESH");
    assert.equal(set.content[0].type, "text");
    assert.ok(set.content[0].text.includes("Parses job input."), "the note is model-visible");
    assert.equal(set.details.content, undefined, "the content text is not duplicated in details");

    const get = await invoke({ action: "get", path: "a.txt" });
    assert.equal(get.details.error, null, JSON.stringify(get.details.error));
    assert.equal(get.details.records[0].content_hash, get.details.records[0].observed_hash);
    assert.equal(get.details.fresh_count, 1);
    assert.equal(get.details.rendered_record_count, 1);
    assert.equal(get.details.omitted_record_count, 0);
  });

  // --- Read-time memory availability notice (AC-NOTICE-1..7) --------------
  //
  // Changed behavior: a successful `read` of an exact recorded subject has one
  // bounded `<file-memory>` block appended to the unchanged result. The block
  // carries tag names and staleness but no note body; retrieval still requires
  // a deliberate `meta` call. Emission is once per subject per agent run.
  const readEvent = (path, content = [{ type: "text", text: "file bytes" }], isError = false) => ({
    type: "tool_result",
    toolCallId: "read-1",
    toolName: "read",
    input: { path },
    content,
    isError,
    details: undefined,
  });
  const invokeEvent = (name, ...args) => {
    const handler = handlers.get(name);
    return handler ? handler(...args) : undefined;
  };
  const startRun = () => invokeEvent("agent_start");
  const usageRowCount = () => {
    const path = join(workspaceRoot, ".pi", "meta", "usage.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "").length : 0;
  };
  const noticeText = (result) => result.content.map((part) => part.text ?? "").join("\n");

  await check("AC-NOTICE-1", "the notice is appended and the original read content is an unchanged prefix", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "notice1.txt"), "original bytes");
    await invoke({ action: "set", path: "notice1.txt", tag: "summary", note: "note body N1" });
    const original = [{ type: "text", text: "original bytes" }];
    const result = await invokeEvent("tool_result", readEvent("notice1.txt", original), ctx);
    assert.ok(result, "the first read is annotated");
    assert.equal(result.content.length, original.length + 1, "exactly one block is appended");
    for (let i = 0; i < original.length; i += 1) assert.deepEqual(result.content[i], original[i], `original part ${i} is unchanged`);
    const appended = result.content[result.content.length - 1];
    assert.equal(appended.type, "text", "the appended part is text");
    assert.match(appended.text, /^<file-memory>\n/, "the block opens the element");
    assert.match(appended.text, /\n<\/file-memory>$/, "the block closes the element");
    assert.equal(result.isError, undefined, "no error flag is set");
    assert.equal(result.details, undefined, "no details are set");
  });

  await check("AC-NOTICE-2", "the notice lists tags and staleness, gives one concrete get for a single tag, and carries no body", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "notice2single.txt"), "single bytes");
    await invoke({ action: "set", path: "notice2single.txt", tag: "summary", note: "single body N2" });
    const singleText = noticeText(await invokeEvent("tool_result", readEvent("notice2single.txt"), ctx));
    assert.match(singleText, /notice2single\.txt/, "the subject is named");
    assert.match(singleText, /summary/, "the tag is listed");
    assert.match(singleText, /\[FRESH\]/, "the staleness state is listed");
    assert.match(singleText, /meta get/, "a get call is suggested");
    assert.match(singleText, /tag: "summary"/, "the single tag is concrete");
    assert.ok(!singleText.includes("single body N2"), "no note body is carried");
    assert.ok(Buffer.byteLength(singleText, "utf8") <= 4096, "the block is bounded");

    writeFileSync(join(workspaceRoot, "notice2multi.txt"), "multi bytes");
    await invoke({ action: "set", path: "notice2multi.txt", tag: "summary", note: "multi summary N2" });
    await invoke({ action: "set", path: "notice2multi.txt", tag: "intent", note: "multi intent N2" });
    const multiText = noticeText(await invokeEvent("tool_result", readEvent("notice2multi.txt"), ctx));
    assert.match(multiText, /summary/, "the first tag is listed");
    assert.match(multiText, /intent/, "the second tag is listed");
    assert.ok(!multiText.includes("multi summary N2") && !multiText.includes("multi intent N2"), "no note body is carried");
  });

  await check("AC-NOTICE-3", "sequential reads of one subject in a run emit the notice once, and turn_start does not clear it", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "notice3.txt"), "chunked bytes");
    await invoke({ action: "set", path: "notice3.txt", tag: "summary", note: "chunked N3" });
    const first = await invokeEvent("tool_result", readEvent("notice3.txt"), ctx);
    assert.ok(first, "the first chunk is annotated");
    await invokeEvent("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 });
    const second = await invokeEvent("tool_result", readEvent("notice3.txt"), ctx);
    assert.equal(second, undefined, "a later chunk in the same run is not annotated again");
  });

  await check("AC-NOTICE-4", "agent_start clears the per-run set so a new run surfaces the notice again", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "notice4.txt"), "run bytes");
    await invoke({ action: "set", path: "notice4.txt", tag: "summary", note: "run N4" });
    const first = await invokeEvent("tool_result", readEvent("notice4.txt"), ctx);
    assert.ok(first, "the first run is annotated");
    await startRun();
    const second = await invokeEvent("tool_result", readEvent("notice4.txt"), ctx);
    assert.ok(second, "the next run is annotated again");
  });

  await check("AC-NOTICE-5", "session_compact clears the per-run set so compaction can resurface the notice", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "notice5.txt"), "compact bytes");
    await invoke({ action: "set", path: "notice5.txt", tag: "summary", note: "compact N5" });
    const first = await invokeEvent("tool_result", readEvent("notice5.txt"), ctx);
    assert.ok(first, "the pre-compaction read is annotated");
    await invokeEvent("session_compact", { type: "session_compact", trigger: "threshold" });
    const second = await invokeEvent("tool_result", readEvent("notice5.txt"), ctx);
    assert.ok(second, "the post-compaction read is annotated again");
  });

  await check("AC-NOTICE-6", "unrecorded, non-text, error, and outside reads pass through unchanged", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "notice6.txt"), "text bytes");
    await invoke({ action: "set", path: "notice6.txt", tag: "summary", note: "text N6" });
    assert.equal(await invokeEvent("tool_result", readEvent("unrecorded-n6.txt"), ctx), undefined, "no records means no notice");
    const mixed = [{ type: "text", text: "mixed" }, { type: "image", data: "AAAA", mimeType: "image/png" }];
    assert.equal(await invokeEvent("tool_result", readEvent("notice6.txt", mixed), ctx), undefined, "non-text results pass through");
    assert.equal(await invokeEvent("tool_result", readEvent("notice6.txt", [{ type: "text", text: "err" }], true), ctx), undefined, "error results pass through");
    assert.equal(await invokeEvent("tool_result", readEvent("../outside.txt"), ctx), undefined, "outside paths pass through");
  });

  await check("AC-NOTICE-7", "the notice appends no usage-log row", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "notice7.txt"), "quiet bytes");
    await invoke({ action: "set", path: "notice7.txt", tag: "summary", note: "quiet N7" });
    const afterSet = usageRowCount();
    await invokeEvent("tool_result", readEvent("notice7.txt"), ctx);
    assert.equal(usageRowCount(), afterSet, "the notice logs nothing");
  });

  // --- Edit/write memory-update notice (AC-NOTICE-12..16) -----------------
  //
  // Changed behavior: a successful `edit` or `write` of an exact recorded
  // subject has one bounded `<file-memory-update>` block appended. The block
  // lists tags and post-mutation staleness and asks the caller to update a
  // record only when reusable knowledge changed. The extension never writes.
  const editEvent = (path, content = [{ type: "text", text: `Successfully replaced 1 block(s) in ${path}.` }], toolName = "edit", isError = false) => ({
    type: "tool_result",
    toolCallId: "edit-1",
    toolName,
    input: { path },
    content,
    isError,
    details: undefined,
  });

  await check("AC-NOTICE-12", "an edit result gets one appended update notice and preserves the original content", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "update12.txt"), "before");
    await invoke({ action: "set", path: "update12.txt", tag: "summary", note: "body U12" });
    const original = [{ type: "text", text: "Successfully replaced 1 block(s) in update12.txt." }];
    writeFileSync(join(workspaceRoot, "update12.txt"), "after");
    const result = await invokeEvent("tool_result", editEvent("update12.txt", original), ctx);
    assert.ok(result, "the edit result is annotated");
    assert.equal(result.content.length, original.length + 1, "exactly one block is appended");
    for (let i = 0; i < original.length; i += 1) assert.deepEqual(result.content[i], original[i], `original part ${i} is unchanged`);
    const appended = result.content[result.content.length - 1];
    assert.equal(appended.type, "text", "the appended part is text");
    assert.match(appended.text, /^<file-memory-update>\n/, "the block opens the element");
    assert.match(appended.text, /\n<\/file-memory-update>$/, "the block closes the element");
    assert.match(appended.text, /update12\.txt/, "the subject is named");
    assert.match(appended.text, /summary/, "the tag is listed");
    assert.match(appended.text, /\[STALE\]/, "post-mutation staleness is listed");
    assert.ok(!appended.text.includes("body U12"), "no note body is carried");
    assert.match(appended.text, /meta set/, "an update call is suggested");
    assert.equal(result.isError, undefined, "no error flag is set");
    assert.equal(result.details, undefined, "no details are set");
    assert.ok(Buffer.byteLength(appended.text, "utf8") <= 4096, "the block is bounded");
  });

  await check("AC-NOTICE-13", "recorded writes are annotated; other mutations pass through", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "update13.txt"), "before");
    await invoke({ action: "set", path: "update13.txt", tag: "summary", note: "body U13" });
    writeFileSync(join(workspaceRoot, "update13.txt"), "after");
    const writeResult = await invokeEvent("tool_result", editEvent("update13.txt", [{ type: "text", text: "Successfully wrote to update13.txt" }], "write"), ctx);
    assert.ok(writeResult, "a recorded write is annotated");
    assert.match(writeResult.content[writeResult.content.length - 1].text, /<file-memory-update>/, "the write notice uses the update element");
    assert.equal(await invokeEvent("tool_result", editEvent("unrecorded-u13.txt"), ctx), undefined, "an unrecorded edit passes through");
    const mixed = [{ type: "text", text: "ok" }, { type: "image", data: "AAAA", mimeType: "image/png" }];
    assert.equal(await invokeEvent("tool_result", editEvent("update13.txt", mixed), ctx), undefined, "a non-text result passes through");
    assert.equal(await invokeEvent("tool_result", editEvent("update13.txt", [{ type: "text", text: "err" }], "edit", true), ctx), undefined, "an error result passes through");
    assert.equal(await invokeEvent("tool_result", editEvent("../outside.txt"), ctx), undefined, "an outside edit path passes through");
  });

  await check("AC-NOTICE-14", "the update notice writes nothing automatically", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "update14.txt"), "before");
    await invoke({ action: "set", path: "update14.txt", tag: "summary", note: "body U14" });
    const indexBefore = readFileSync(join(workspaceRoot, ".pi", "meta", "index.json"), "utf8");
    const rowsBefore = usageRowCount();
    writeFileSync(join(workspaceRoot, "update14.txt"), "after");
    await invokeEvent("tool_result", editEvent("update14.txt"), ctx);
    assert.equal(readFileSync(join(workspaceRoot, ".pi", "meta", "index.json"), "utf8"), indexBefore, "the index is unchanged");
    assert.equal(usageRowCount(), rowsBefore, "no usage row is appended");
  });

  await check("AC-NOTICE-15", "the update notice is once per subject per run and resets on agent_start and session_compact", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "update15.txt"), "before");
    await invoke({ action: "set", path: "update15.txt", tag: "summary", note: "body U15" });
    writeFileSync(join(workspaceRoot, "update15.txt"), "after");
    assert.ok(await invokeEvent("tool_result", editEvent("update15.txt"), ctx), "the first edit is annotated");
    await invokeEvent("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 });
    assert.equal(await invokeEvent("tool_result", editEvent("update15.txt"), ctx), undefined, "a turn boundary does not repeat the notice");
    await startRun();
    assert.ok(await invokeEvent("tool_result", editEvent("update15.txt"), ctx), "agent_start resets the notice");
    await invokeEvent("session_compact", { type: "session_compact", trigger: "threshold" });
    assert.ok(await invokeEvent("tool_result", editEvent("update15.txt"), ctx), "session_compact resets the notice");
  });

  await check("AC-NOTICE-16", "the update notice says memory was used earlier after a meta get in the same run", async () => {
    await startRun();
    writeFileSync(join(workspaceRoot, "update16.txt"), "before");
    await invoke({ action: "set", path: "update16.txt", tag: "summary", note: "body U16" });
    const get = await invoke({ action: "get", path: "update16.txt", tag: "summary" });
    await invokeEvent("tool_result", {
      type: "tool_result",
      toolCallId: "meta-1",
      toolName: "meta",
      input: { action: "get", path: "update16.txt", tag: "summary" },
      content: get.content,
      isError: false,
      details: get.details,
    }, ctx);
    writeFileSync(join(workspaceRoot, "update16.txt"), "after");
    const result = await invokeEvent("tool_result", editEvent("update16.txt"), ctx);
    assert.ok(result, "the edit is annotated");
    const text = result.content[result.content.length - 1].text;
    assert.match(text, /earlier/i, "the block says memory was used earlier");
    assert.match(text, /changed/i, "the block says the file changed");
  });

  await check("REQ-MEAS-6", "session_start appends a session observation", async () => {
    const handler = handlers.get("session_start");
    assert.equal(typeof handler, "function", "a session_start handler is registered");
    const cwd = mkdtempSync(join(scratch, "ws-session-"));
    await handler({}, { cwd, hasUI: false, sessionManager: { getSessionId: () => "session-ext" } });
    const rows = readFileSync(join(cwd, ".pi", "meta", "usage.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, "session_observed");
    assert.equal(rows[0].session_id, "session-ext");
    assert.equal(rows[0].result, "ok");
  });

  await check("AC-18", "a caller-supplied author is rejected and writes nothing", async () => {
    const before = await invoke({ action: "tags" });
    const result = await invoke({ action: "set", path: "a.txt", tag: "summary", note: "x", author: "bob" });
    assert.equal(result.details.error?.code, "INVALID_ARGS");
    assert.equal(result.details.error?.parameter, "author");
    const after = await invoke({ action: "tags" });
    assert.deepEqual(after.details.tags, before.details.tags, "no record was written");
  });
  await check("AC-31", "Pi's preflight rejects malformed arguments before execution and mutates nothing", async () => {
    const { validateToolArguments } = await import(pathToFileURL(validationLoader).href);
    const cwd = mkdtempSync(join(scratch, "ws-preflight-"));
    let invocations = 0;
    const hostCall = async (args) => {
      const validated = validateToolArguments(tool, { name: "meta", arguments: args });
      invocations += 1;
      return tool.execute("call-preflight", validated, undefined, undefined, {
        cwd,
        sessionManager: { getSessionId: () => "session-preflight" },
      });
    };
    // Pi's schema gate rejects a missing or unknown action, an out-of-range limit,
    // and a wrong argument type. Extraneous fields pass this gate and are the
    // extension's own INVALID_ARGS concern (REQ-TOOL-6).
    for (const args of [{}, { action: "frobnicate" }, { action: "query", limit: 51 }, { action: "query", limit: 0 }, { action: 7 }]) {
      await assert.rejects(hostCall(args), (error) => {
        assert.ok(error instanceof Error, `a host error is thrown for ${JSON.stringify(args)}`);
        assert.match(error.message, /Validation failed for tool "meta"/, `host validation message for ${JSON.stringify(args)}`);
        assert.equal(error.code, undefined, `no extension envelope for ${JSON.stringify(args)}`);
        return true;
      });
    }
    assert.equal(invocations, 0, "extension execution was never reached");
    assert.equal(existsSync(join(cwd, ".pi", "meta", "index.json")), false, "no index was written");
    assert.equal(existsSync(join(cwd, ".pi", "meta", "usage.jsonl")), false, "no usage row was logged");
  });

  // --- AC-17 Pi hook and provider-payload observer ------------------------
  //
  // The observer runs Pi's real ExtensionRunner dispatch for the `context`,
  // `before_agent_start`, and `before_provider_request` hooks plus the
  // `sendMessage`, `sendUserMessage`, and `appendEntry` sinks. It audits only
  // model-visible text: a tool result's `details` is session state, not
  // provider content (REQ-TOOL-16, AC-17c).
  const piSdk = await import(pathToFileURL(join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);

  function loadHarnessExtension(factory, extPath, runtime) {
    const handlers = new Map();
    const tools = new Map();
    const api = {
      on: (name, handler) => {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerTool: (registered) => tools.set(registered.name, { definition: registered }),
      registerCommand: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      registerMessageRenderer: () => {},
      registerMarkdownTransformer: () => {},
      registerEntryRenderer: () => {},
      getFlag: () => undefined,
      sendMessage: (...args) => runtime.sendMessage(...args),
      sendUserMessage: (...args) => runtime.sendUserMessage(...args),
      appendEntry: (...args) => runtime.appendEntry(...args),
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
    };
    factory(api);
    return {
      path: extPath,
      resolvedPath: extPath,
      handlers,
      tools,
      messageRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
      sourceInfo: {},
    };
  }

  function harnessRunner(factory, cwd, sessionId) {
    const runtime = piSdk.createExtensionRuntime();
    const loaded = loadHarnessExtension(factory, "harness", runtime);
    const runner = new piSdk.ExtensionRunner([loaded], runtime, cwd, { getSessionId: () => sessionId }, { registerProvider: () => {} });
    const sinks = { sendMessage: [], sendUserMessage: [], appendEntry: [] };
    runner.bindCore(
      {
        sendMessage: (message) => sinks.sendMessage.push(message),
        sendUserMessage: (content) => sinks.sendUserMessage.push(content),
        appendEntry: (customType, data) => sinks.appendEntry.push({ customType, data }),
        setSessionName: () => {},
        getSessionName: () => undefined,
        setLabel: () => {},
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => {},
        refreshTools: () => {},
        getCommands: () => [],
        setModel: async () => {},
        getThinkingLevel: () => "off",
        setThinkingLevel: () => {},
      },
      {
        getModel: () => undefined,
        getScopedModels: () => [],
        isIdle: () => true,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
      },
    );
    return { runner, sinks };
  }

  const modelVisible = (message) => {
    const content = Array.isArray(message?.content) ? message.content : message?.content === undefined ? [] : [message.content];
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n");
  };

  function sentinelLeaks(state, sentinel, allowed) {
    const found = [];
    state.sessionMessages.forEach((message, index) => {
      if (!allowed.has(index) && modelVisible(message).includes(sentinel)) found.push(`messages[${index}]`);
    });
    (state.providerPayload?.messages ?? []).forEach((message, index) => {
      if (!allowed.has(index) && modelVisible(message).includes(sentinel)) found.push(`payload.messages[${index}]`);
    });
    const { messages: _messages, ...payloadRest } = state.providerPayload ?? {};
    if (JSON.stringify(payloadRest).includes(sentinel)) found.push("providerPayload");
    if (JSON.stringify(state.systemPromptOptions ?? {}).includes(sentinel)) found.push("systemPromptOptions");
    if (JSON.stringify(state.sinks).includes(sentinel)) found.push("sinks");
    return found;
  }

  async function runHookPipeline(factory, cwd, sessionId, inputMessages) {
    const { runner, sinks } = harnessRunner(factory, cwd, sessionId);
    const sessionMessages = await runner.emitContext(structuredClone(inputMessages));
    const beforeAgent = await runner.emitBeforeAgentStart("observer prompt", undefined, { cwd });
    const providerPayload = await runner.emitBeforeProviderRequest({
      model: "observer-model",
      system: "observer system prompt",
      messages: structuredClone(sessionMessages),
      tools: [],
    });
    return { sessionMessages, providerPayload, systemPromptOptions: beforeAgent.systemPromptOptions, sinks };
  }

  await check("AC-17", "meta leaves the sentinel only in normal tool-call and tool-result context", async () => {
    const cwd = mkdtempSync(join(scratch, "ws-ac17-"));
    const sentinel = "SENTINEL-AC17-UNIQUE";
    writeFileSync(join(cwd, "a.txt"), "bytes");
    const { runner } = harnessRunner(extension, cwd, "sess-A");
    const definition = runner.getToolDefinition("meta");
    const asSession = (id) => ({ cwd, sessionManager: { getSessionId: () => id } });
    const set = await definition.execute("call-set", { action: "set", path: "a.txt", tag: "summary", note: sentinel }, undefined, undefined, asSession("sess-A"));
    assert.equal(set.details.error, null, JSON.stringify(set.details.error));
    const get = await definition.execute("call-get", { action: "get", path: "a.txt" }, undefined, undefined, asSession("sess-B"));
    assert.equal(get.details.error, null, JSON.stringify(get.details.error));
    assert.ok(get.content[0].text.includes(sentinel), "the note is in the bounded tool result");
    const messages = [
      { role: "user", content: "remember a.txt" },
      { role: "assistant", content: [{ type: "text", text: "storing" }, { type: "toolCall", id: "call-set", name: "meta", arguments: { action: "set", path: "a.txt", tag: "summary", note: sentinel } }] },
      { role: "toolResult", toolCallId: "call-set", toolName: "meta", content: set.content, details: set.details },
      { role: "assistant", content: [{ type: "text", text: "recalling" }, { type: "toolCall", id: "call-get", name: "meta", arguments: { action: "get", path: "a.txt" } }] },
      { role: "toolResult", toolCallId: "call-get", toolName: "meta", content: get.content, details: get.details },
    ];
    const state = await runHookPipeline(extension, cwd, "sess-B", messages);
    assert.deepEqual(sentinelLeaks(state, sentinel, new Set([1, 2, 4])), [], "no hook or provider region carries the sentinel");
    assert.ok(modelVisible(state.sessionMessages[2]).includes(sentinel), "the tool result keeps the note");
  });

  await check("AC-17b", "the observer rejects every named sentinel injection", async () => {
    const cwd = mkdtempSync(join(scratch, "ws-ac17b-"));
    const sentinel = "SENTINEL-AC17B-UNIQUE";
    const messages = [
      { role: "user", content: "remember a.txt" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-set", name: "meta", arguments: { action: "set", path: "a.txt", tag: "summary", note: sentinel } }] },
      { role: "toolResult", toolCallId: "call-set", toolName: "meta", content: [{ type: "text", text: `stored: ${sentinel}` }], details: { records: [{ note: sentinel }] } },
    ];
    const allowed = new Set([1, 2]);
    const variants = {
      "context in place": (api) => api.on("context", (event) => { event.messages[0].content = sentinel; }),
      "context replacement": (api) => api.on("context", (event) => ({ messages: [...event.messages, { role: "user", content: sentinel }] })),
      "before_agent_start in place": (api) => api.on("before_agent_start", (event) => { event.systemPromptOptions.appendSystemPrompt = sentinel; }),
      "before_agent_start replacement": (api) => api.on("before_agent_start", () => ({ systemPrompt: sentinel })),
      "before_provider_request in place": (api) => api.on("before_provider_request", (event) => { event.payload.messages[0].content = sentinel; }),
      "before_provider_request replacement": (api) => api.on("before_provider_request", (event) => ({ ...event.payload, system: sentinel })),
      sendMessage: (api) => api.on("before_agent_start", () => { api.sendMessage({ customType: "x", content: sentinel, display: true }); }),
      sendUserMessage: (api) => api.on("before_agent_start", () => { api.sendUserMessage(sentinel); }),
      appendEntry: (api) => api.on("before_agent_start", () => { api.appendEntry("x", sentinel); }),
    };
    for (const [name, factory] of Object.entries(variants)) {
      const state = await runHookPipeline(factory, cwd, "sess-B", messages);
      assert.ok(sentinelLeaks(state, sentinel, allowed).length > 0, `${name} was detected`);
    }
    const clean = await runHookPipeline(extension, cwd, "sess-B", messages);
    assert.deepEqual(sentinelLeaks(clean, sentinel, allowed), [], "unchanged legitimate forwarding passes");
  });

  await check("AC-17c", "a details-only note stays out of provider content", async () => {
    const cwd = mkdtempSync(join(scratch, "ws-ac17c-"));
    const sentinel = "SENTINEL-AC17C-UNIQUE";
    const filler = "f".repeat(3000);
    const { runner } = harnessRunner(extension, cwd, "sess-A");
    const definition = runner.getToolDefinition("meta");
    const asSession = (id) => ({ cwd, sessionManager: { getSessionId: () => id } });
    for (let index = 0; index < 20; index += 1) {
      const name = `s${String(index).padStart(2, "0")}.txt`;
      writeFileSync(join(cwd, name), `${name} bytes`);
      const note = index === 19 ? `${filler}${sentinel}` : `${filler}${name}`;
      const set = await definition.execute(`set-${index}`, { action: "set", path: name, tag: "summary", note }, undefined, undefined, asSession("sess-A"));
      assert.equal(set.details.error, null, JSON.stringify(set.details.error));
    }
    const query = await definition.execute("query-1", { action: "query", limit: 20 }, undefined, undefined, asSession("sess-B"));
    assert.equal(query.details.error, null, JSON.stringify(query.details.error));
    assert.ok(query.details.omitted_record_count > 0, "at least one record is omitted from content");
    assert.ok(!query.content[0].text.includes(sentinel), "the sentinel is absent from bounded content");
    assert.ok(query.details.records.some((record) => record.note.includes(sentinel)), "the sentinel is retained in details");
    const messages = [
      { role: "user", content: "recall recent notes" },
      { role: "assistant", content: [{ type: "toolCall", id: "query-1", name: "meta", arguments: { action: "query", limit: 20 } }] },
      { role: "toolResult", toolCallId: "query-1", toolName: "meta", content: query.content, details: query.details },
    ];
    const state = await runHookPipeline(extension, cwd, "sess-B", messages);
    assert.deepEqual(sentinelLeaks(state, sentinel, new Set()), [], "no hook promotes the details-only note");
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  const marker = result.ok ? "PASS" : "FAIL";
  console.log(`${marker} ${result.ac} ${result.name}${result.ok ? "" : `\n     ${result.reason}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((result) => `${result.ac} (${result.reason.split("\n")[0]})`).join(", ")}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
