#!/usr/bin/env node
// Local diagnostic: did a Pi session load the meta-memory skill and call the
// meta tool, and when relative to source reconstruction?
//
// This is NOT the spec's experiment evaluator. Section 14 of the meta
// specification measures use_rate/fresh_ratio/stale_load/cross_session_reuse
// from .pi/meta/usage.jsonl. The usage log records neither skill loading nor
// prompt contents, so the questions here can only be answered from Pi session
// transcripts. Treat this as a debugging instrument, not experiment evidence.
//
// Usage:
//   node scripts/diagnose-meta-adherence.mjs --session-dir DIR [--match REGEX]
//   node scripts/diagnose-meta-adherence.mjs --profile new-coder
//   node scripts/diagnose-meta-adherence.mjs --json
//
// Defaults to $PI_CODING_AGENT_SESSION_DIR when neither option is given.
// --profile NAME resolves against the profiles root, which is
// $PI_PROFILES_DIR, else the parent of $PI_CODING_AGENT_DIR, else
// /root/.config/pi/profiles. Override it with --profiles-root DIR.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const EARLY_TOOL_BUDGET = 3; // meta at or before this 0-based index counts as early

function parseArgs(argv) {
  const opts = { sessionDirs: [], profiles: [], profilesRoot: null, match: null, json: false, quiet: false, since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session-dir") opts.sessionDirs.push(argv[++i]);
    else if (a === "--profile") opts.profiles.push(argv[++i]);
    else if (a === "--profiles-root") opts.profilesRoot = argv[++i];
    else if (a === "--match") opts.match = argv[++i];
    else if (a === "--since") opts.since = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function usage() {
  console.log(`diagnose-meta-adherence.mjs — classify Pi sessions by meta-memory use

Options:
  --session-dir DIR   Session directory (repeatable)
  --profile NAME      Adds <profiles-root>/NAME/sessions (repeatable)
  --profiles-root DIR Root for --profile; default $PI_PROFILES_DIR, else the
                      parent of $PI_CODING_AGENT_DIR, else /root/.config/pi/profiles
  --match REGEX       Only sessions whose first user prompt matches
  --since MINUTES     Only sessions modified within the last N minutes
  --json              Emit JSON instead of a table
  --quiet             Table only, no summary notes
  -h, --help          This text`);
}

function defaultProfilesRoot() {
  if (process.env.PI_PROFILES_DIR) return resolve(process.env.PI_PROFILES_DIR);
  if (process.env.PI_CODING_AGENT_DIR) return dirname(resolve(process.env.PI_CODING_AGENT_DIR));
  return "/root/.config/pi/profiles";
}

function resolveSessionDirs(opts) {
  const dirs = [...opts.sessionDirs];
  if (opts.profiles.length) {
    const root = opts.profilesRoot ? resolve(opts.profilesRoot) : defaultProfilesRoot();
    for (const name of opts.profiles) dirs.push(join(root, name, "sessions"));
  }
  if (dirs.length === 0 && process.env.PI_CODING_AGENT_SESSION_DIR) {
    dirs.push(process.env.PI_CODING_AGENT_SESSION_DIR);
  }
  return [...new Set(dirs.map((d) => resolve(d)))];
}

function listSessionFiles(dirs, sinceMinutes) {
  const files = [];
  const cutoff = sinceMinutes != null ? Date.now() - sinceMinutes * 60_000 : null;
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (cutoff != null && st.mtimeMs < cutoff) continue;
        files.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  return files;
}

function readSession(file) {
  const raw = readFileSync(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const SOURCE_CMD = /\b(git|cat|sed|head|tail|ls|find|rg|grep|diff|stat|awk|rev-parse|log|show|status|branch)\b/;

function pathOf(call) {
  const p = call.args?.path ?? call.args?.file_path ?? "";
  return typeof p === "string" ? p : "";
}

function isSkillRead(call) {
  return call.name === "read" && pathOf(call).includes("meta-memory") && pathOf(call).endsWith("SKILL.md");
}

function isMeta(call) {
  return call.name === "meta";
}

function isSourceInspection(call) {
  if (call.name === "read") return !pathOf(call).endsWith("SKILL.md");
  if (call.name === "grep" || call.name === "find" || call.name === "ls") return true;
  if (call.name === "bash") {
    const cmd = call.args?.command ?? "";
    return typeof cmd === "string" && SOURCE_CMD.test(cmd);
  }
  return false;
}

function classify(calls, skillInjected = false) {
  const skillIndex = calls.findIndex(isSkillRead);
  const metaIndex = calls.findIndex(isMeta);
  const skillLoaded = skillIndex !== -1 || skillInjected;
  const metaCalled = metaIndex !== -1;

  const before = metaCalled ? calls.slice(0, metaIndex) : calls;
  const inspectionsBefore = before.filter(isSourceInspection).length;
  const metaEarly =
    metaCalled && (metaIndex <= EARLY_TOOL_BUDGET || inspectionsBefore === 0);

  let state;
  if (!skillLoaded && !metaCalled) state = "S0";
  else if (skillLoaded && !metaCalled) state = "S1";
  else if (!skillLoaded && metaCalled) state = "S2";
  else state = "S3";

  return {
    state,
    skillLoaded,
    metaCalled,
    metaEarly,
    skillIndex: skillIndex === -1 ? null : skillIndex,
    metaIndex: metaIndex === null ? null : metaIndex,
    inspectionsBeforeMeta: metaCalled ? inspectionsBefore : null,
    firstTool: calls.length ? calls[0].name : null,
    calls: calls.length,
  };
}

function analyzeSession(file) {
  const lines = readSession(file);
  const session = lines.find((o) => o.type === "session");
  const model = lines.find((o) => o.type === "model_change");

  let rules = "";
  let skills = "";
  let tools = "";
  for (const o of lines) {
    if (o.type !== "message" || o.message?.role !== "system") continue;
    const s = o.message.sections ?? {};
    rules += s.rules ?? "";
    skills += s.skills ?? "";
    tools += s.tools ?? "";
  }

  const calls = [];
  let userPromptRaw = null;
  for (const o of lines) {
    if (o.type !== "message") continue;
    if (o.message?.role === "user" && userPromptRaw === null) {
      const c = o.message.content;
      userPromptRaw = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text ?? "").join("") : null;
    }
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      if (block?.type === "toolCall" && block.name) {
        calls.push({ name: block.name, args: block.arguments ?? {} });
      }
    }
  }

  // Explicit /skill:meta-memory injects the body into the user message rather
  // than issuing a read call, so a read-only detector misses it.
  const skillInjected = !!userPromptRaw && /<skill name="meta-memory"/.test(userPromptRaw);
  const verdict = classify(calls, skillInjected);
  const displayPrompt = userPromptRaw ? userPromptRaw.replace(/<skill[\s\S]*?<\/skill>/g, "[skill] ").trim() : null;
  return {
    file,
    sessionId: session?.id ?? null,
    cwd: session?.cwd ?? null,
    provider: model?.provider ?? null,
    model: model?.modelId ?? null,
    userPrompt: displayPrompt ? displayPrompt.replace(/\s+/g, " ").slice(0, 80) : null,
    skillInjected,
    ruleVisible: rules.includes("before reconstructing that context from source"),
    skillAdvertised: skills.includes("meta-memory"),
    metaToolAvailable: /(^|\n)- meta:/.test(tools),
    ...verdict,
  };
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  usage();
  process.exit(0);
}

const dirs = resolveSessionDirs(opts);
if (dirs.length === 0) {
  console.error("No session directory. Pass --session-dir, --profile, or set PI_CODING_AGENT_SESSION_DIR.");
  process.exit(2);
}

let files = listSessionFiles(dirs, opts.since);
let results = files.map(analyzeSession);

if (opts.match) {
  const re = new RegExp(opts.match, "i");
  results = results.filter((r) => r.userPrompt && re.test(r.userPrompt));
}

results.sort((a, b) => String(b.sessionId).localeCompare(String(a.sessionId)));

if (opts.json) {
  console.log(JSON.stringify({ dirs, count: results.length, sessions: results }, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s ?? "").padEnd(n);
const padL = (s, n) => String(s ?? "").padStart(n);

console.log(`session dirs: ${dirs.join(", ")}`);
console.log(`sessions: ${results.length}`);
console.log("");
console.log(
  pad("state", 6) +
    pad("skill", 6) +
    pad("meta", 5) +
    pad("early", 6) +
    padL("tools", 6) +
    "  " +
    pad("model", 22) +
    pad("first", 8) +
    "prompt",
);
for (const r of results) {
  console.log(
    pad(r.state, 6) +
      pad(r.skillLoaded ? "yes" : "no", 6) +
      pad(r.metaCalled ? "yes" : "no", 5) +
      pad(r.metaCalled ? (r.metaEarly ? "yes" : "no") : "-", 6) +
      padL(r.calls, 6) +
      "  " +
      pad(r.model ?? "-", 22) +
      pad(r.firstTool ?? "-", 8) +
      (r.userPrompt ?? "(no user text)"),
  );
}

if (!opts.quiet) {
  const byState = {};
  for (const r of results) byState[r.state] = (byState[r.state] ?? 0) + 1;
  console.log("");
  console.log(
    `S0 (neither) ${byState.S0 ?? 0} | S1 (skill only) ${byState.S1 ?? 0} | ` +
      `S2 (meta only) ${byState.S2 ?? 0} | S3 (both) ${byState.S3 ?? 0}`,
  );
  const missingPrompt = results.filter((r) => !r.ruleVisible || !r.skillAdvertised).length;
  if (missingPrompt) {
    console.log(
      `WARNING: ${missingPrompt} session(s) lack the meta rule or the advertised skill; not comparable evidence.`,
    );
  }
  console.log(
    "Note: this classifies transcripts, not the section 14 experiment. The usage log cannot answer these questions.",
  );
}
