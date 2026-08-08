# Windows DAP dap-dbgeng Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `dap-dbgeng` as a built-in DAP adapter and prefer it on Windows for local `.exe` launch and PID attach, without bundling the binary or adding dump/remote/kernel/MCP paths.

**Architecture:** Keep the pure DAP client model. Add one `defaults.json` entry; make extensionless/attach preference order platform-gated at call time (not module-load const); surface a dedicated unavailable install hint. No new protocol layer.

**Tech Stack:** TypeScript, Bun test (`bun:test` + `vi.spyOn` / temporary `process.platform` override with restore), existing `packages/coding-agent/src/dap/*` and `tools/debug.ts`.

**Spec:** `docs/superpowers/specs/2026-08-08-windows-dap-dbgeng-design.md`

## Global Constraints

- Adapter id / command: `dap-dbgeng` (not `dbgeng`).
- Discovery: PATH / existing `resolveCommand` only — no VS Code extension scan, no download.
- v1 scenarios only: local launch + attach-by-PID.
- Selection priority changes: `process.platform === "win32"` only.
- launchDefaults use `stopAtEntry` (dap-dbgeng schema), not `stopOnEntry`.
- No mcp-windbg / Python / host CDB text bridge.
- Tests: full-suite safe; restore platform mocks; no real `dap-dbgeng.exe` or Windows Kits required in CI.
- Never use `mock.module()`; prefer local `dap.json` command overrides + temp executables.
- Never commit unless the user asks (plan steps that say Commit are optional until requested).
- Verify with `bun test packages/coding-agent/test/debug/dap-config.test.ts` (and any new sibling file); package-wide `bun check` only if types/exports change.

## File map

| File | Responsibility |
|---|---|
| `packages/coding-agent/src/dap/defaults.json` | Built-in adapter registry entry |
| `packages/coding-agent/src/dap/config.ts` | Platform-gated preferred debugger order used by launch sort + attach select |
| `packages/coding-agent/src/tools/debug.ts` | Unavailable install hint + adapter schema description (+ optional example) |
| `packages/coding-agent/src/prompts/tools/debug.md` | One-line Windows note for the agent |
| `packages/coding-agent/test/debug/dap-config.test.ts` | Registry + selection contracts |
| `packages/coding-agent/CHANGELOG.md` | Unreleased Added entry |

No new runtime modules. No session.ts changes expected (`processId` already dual-sent; launchDefaults already spread).

---

### Task 1: Registry entry + unavailable hint + docs surface

**Files:**
- Modify: `packages/coding-agent/src/dap/defaults.json` (append before closing `}`)
- Modify: `packages/coding-agent/src/tools/debug.ts` (`ADAPTER_UNAVAILABLE_MESSAGES`, `ADAPTER_CANONICAL_COMMANDS`, `adapter?` describe string; optional example)
- Modify: `packages/coding-agent/src/prompts/tools/debug.md`
- Modify: `packages/coding-agent/CHANGELOG.md` (`## [Unreleased]` → add `### Added` if missing)
- Test: `packages/coding-agent/test/debug/dap-config.test.ts`

**Interfaces:**
- Consumes: existing `DapAdapterConfig` shape in `defaults.json`
- Produces: built-in adapter key `dap-dbgeng` with command `dap-dbgeng`; unavailable message key `dap-dbgeng`

- [ ] **Step 1: Write the failing registry test**

Append inside `describe("DAP adapter configuration", () => { ... })` in `packages/coding-agent/test/debug/dap-config.test.ts`:

```ts
it("registers built-in dap-dbgeng with Windows-oriented defaults", () => {
	const config = getAdapterConfigs().dap-dbgeng;
	// NOTE: use bracket access — the id contains a hyphen
	const dbgeng = getAdapterConfigs()["dap-dbgeng"];
	expect(dbgeng).toBeDefined();
	expect(dbgeng?.command).toBe("dap-dbgeng");
	expect(dbgeng?.args ?? []).toEqual([]);
	expect(dbgeng?.languages).toEqual(["c", "cpp"]);
	expect(dbgeng?.fileTypes).toEqual(
		expect.arrayContaining([".c", ".cpp", ".exe", ".h", ".hpp"]),
	);
	expect(dbgeng?.rootMarkers).toEqual(
		expect.arrayContaining(["CMakeLists.txt", "compile_commands.json", "*.sln", "*.vcxproj"]),
	);
	expect(dbgeng?.launchDefaults).toMatchObject({
		request: "launch",
		stopAtEntry: true,
	});
	expect(dbgeng?.launchDefaults).not.toHaveProperty("stopOnEntry");
	expect(dbgeng?.attachDefaults).toMatchObject({ request: "attach" });
});
```

Fix the accidental `getAdapterConfigs().dap-dbgeng` line — final test must only use bracket access:

```ts
it("registers built-in dap-dbgeng with Windows-oriented defaults", () => {
	const dbgeng = getAdapterConfigs()["dap-dbgeng"];
	expect(dbgeng).toBeDefined();
	expect(dbgeng?.command).toBe("dap-dbgeng");
	expect(dbgeng?.args ?? []).toEqual([]);
	expect(dbgeng?.languages).toEqual(["c", "cpp"]);
	expect(dbgeng?.fileTypes).toEqual(
		expect.arrayContaining([".c", ".cpp", ".exe", ".h", ".hpp"]),
	);
	expect(dbgeng?.rootMarkers).toEqual(
		expect.arrayContaining(["CMakeLists.txt", "compile_commands.json", "*.sln", "*.vcxproj"]),
	);
	expect(dbgeng?.launchDefaults).toMatchObject({
		request: "launch",
		stopAtEntry: true,
	});
	expect(dbgeng?.launchDefaults).not.toHaveProperty("stopOnEntry");
	expect(dbgeng?.attachDefaults).toMatchObject({ request: "attach" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test packages/coding-agent/test/debug/dap-config.test.ts -t "registers built-in dap-dbgeng"
```

Expected: FAIL — `dbgeng` undefined / property missing.

- [ ] **Step 3: Add `defaults.json` entry**

Insert as a sibling of existing adapters in `packages/coding-agent/src/dap/defaults.json` (JSON requires a comma after the previous adapter object):

```json
"dap-dbgeng": {
	"command": "dap-dbgeng",
	"args": [],
	"languages": ["c", "cpp"],
	"fileTypes": [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".exe"],
	"rootMarkers": [
		"CMakeLists.txt",
		"Makefile",
		"compile_commands.json",
		"*.sln",
		"*.vcxproj"
	],
	"launchDefaults": {
		"request": "launch",
		"stopAtEntry": true
	},
	"attachDefaults": {
		"request": "attach"
	}
}
```

Do not set `connectMode` (defaults to stdio via resolve path). Do not set `acceptsDirectoryProgram`.

- [ ] **Step 4: Re-run registry test**

Run:

```bash
bun test packages/coding-agent/test/debug/dap-config.test.ts -t "registers built-in dap-dbgeng"
```

Expected: PASS.

- [ ] **Step 5: Wire unavailable message + tool/prompt surface**

In `packages/coding-agent/src/tools/debug.ts`:

1. Extend `ADAPTER_UNAVAILABLE_MESSAGES`:

```ts
const ADAPTER_UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
	debugpy: "adapter 'debugpy' is not available: python not found in PATH",
	dlv: "adapter 'dlv' is not available: install with 'go install github.com/go-delve/delve/cmd/dlv@latest'",
	rdbg: "adapter 'rdbg' is not available: install with 'gem install debug'",
	"js-debug-adapter":
		"adapter 'js-debug-adapter' is not available: download it from https://github.com/microsoft/vscode-js-debug",
	"dap-dbgeng":
		"adapter 'dap-dbgeng' is not available: install dap-dbgeng (https://github.com/svnscha/dap-dbgeng or VS Marketplace svnscha.vscode-dap-dbgeng), put dap-dbgeng on PATH, and ensure Debugging Tools for Windows (dbgeng.dll) is installed",
};
```

2. Extend `ADAPTER_CANONICAL_COMMANDS`:

```ts
const ADAPTER_CANONICAL_COMMANDS: Readonly<Record<string, string>> = {
	debugpy: "python",
	dlv: "dlv",
	rdbg: "rdbg",
	"js-debug-adapter": "js-debug-adapter",
	"dap-dbgeng": "dap-dbgeng",
};
```

3. Update schema describe for `adapter?` (keep existing ids, add `dap-dbgeng`):

```ts
"adapter?": type("string").describe(
	"configured adapter id (gdb, lldb-dap, debugpy, dlv, rdbg, dap-dbgeng, or dap.json entry)",
),
```

4. Optional example near other launch examples:

```ts
{
	caption: "Launch a Windows native executable with dap-dbgeng",
	call: { action: "launch", adapter: "dap-dbgeng", program: "build/Debug/app.exe" },
},
```

In `packages/coding-agent/src/prompts/tools/debug.md`, append a short line after the existing body (keep terse):

```md
Windows native C/C++: adapter `dap-dbgeng` (PATH). Directories need a directory-capable adapter (e.g. `dlv`).
```

If that duplicates the dlv sentence, rewrite the full file to:

```md
Debugger access. Prefer over bash for program state, breakpoints, stepping, or thread inspection.
Only one active session at a time. `program` is a target path, not a shell command.
Directories need a directory-capable adapter (e.g. `dlv`).
Windows native C/C++ uses adapter `dap-dbgeng` when installed on PATH.
```

In `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`, ensure an `### Added` section exists and add:

```md
### Added

- Added built-in Windows native DAP adapter `dap-dbgeng` for local launch and attach-by-PID when the binary is on PATH.
```

If `### Added` already exists under Unreleased, only append the bullet.

- [ ] **Step 6: Smoke the focused test file**

Run:

```bash
bun test packages/coding-agent/test/debug/dap-config.test.ts
```

Expected: all existing tests still PASS; new registry test PASS.

- [ ] **Step 7: Commit (only if user requested commits)**

```bash
git add packages/coding-agent/src/dap/defaults.json packages/coding-agent/src/tools/debug.ts packages/coding-agent/src/prompts/tools/debug.md packages/coding-agent/test/debug/dap-config.test.ts packages/coding-agent/CHANGELOG.md
git commit -m "feat(coding-agent): register built-in dap-dbgeng adapter"
```

---

### Task 2: Win32 selection priority for launch + attach

**Files:**
- Modify: `packages/coding-agent/src/dap/config.ts` (`EXTENSIONLESS_DEBUGGER_ORDER` → call-time helper; all call sites)
- Test: `packages/coding-agent/test/debug/dap-config.test.ts`

**Interfaces:**
- Consumes: `process.platform`, `getAdapterConfigs`, `resolveAdapter` / local override resolution
- Produces:
  - win32 preferred order: `["dap-dbgeng", "lldb-dap", "gdb"]`
  - non-win32 order unchanged: `["gdb", "lldb-dap"]`
  - `selectLaunchAdapter` / `sortAdaptersForLaunch` / `selectAttachAdapter` all use the helper

**Critical implementation detail:** Do **not** keep a module-level const initialized once from `process.platform`. Tests (and long-lived processes) need order to reflect the current platform. Replace:

```ts
const EXTENSIONLESS_DEBUGGER_ORDER: readonly string[] = ["gdb", "lldb-dap"];
```

with:

```ts
function getExtensionlessDebuggerOrder(): readonly string[] {
	return process.platform === "win32"
		? ["dap-dbgeng", "lldb-dap", "gdb"]
		: ["gdb", "lldb-dap"];
}
```

Update every use of `EXTENSIONLESS_DEBUGGER_ORDER` in this file to `getExtensionlessDebuggerOrder()`:

- `selectAutomaticLaunchAdapter` (`includes(name)` filter)
- `sortAdaptersForLaunch` (`indexOf` ranking)
- `selectAttachAdapter` (preferred loop)

- [ ] **Step 1: Write failing selection tests**

Add helpers + tests to `packages/coding-agent/test/debug/dap-config.test.ts`.

Import `selectAttachAdapter` if not already imported:

```ts
import {
	getAdapterConfigs,
	type LaunchAdapterSelection,
	resolveAdapter,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../../src/dap/config";
```

Add platform helper (place near other helpers; restore in the same test’s `finally` — do not leave a file-wide mutation):

```ts
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const original = process.platform;
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", { value: original, configurable: true });
	}
}

async function writeNativeAdapterOverrides(
	cwd: string,
	adapters: Record<string, string>,
): Promise<void> {
	const body: Record<string, { command: string; fileTypes?: string[]; rootMarkers?: string[] }> = {};
	for (const [name, command] of Object.entries(adapters)) {
		body[name] = { command };
	}
	// Preserve built-in fileTypes/languages via partial merge; only override command.
	await fs.writeFile(path.join(cwd, "dap.json"), JSON.stringify({ adapters: body }));
}
```

Tests:

```ts
it("prefers dap-dbgeng for .exe launch on win32 when available", async () => {
	const cwd = await makeTempDir("omp-dap-dbgeng-exe-");
	const dbgengCmd = path.join(cwd, "tools", process.platform === "win32" ? "dap-dbgeng.cmd" : "dap-dbgeng");
	const gdbCmd = path.join(cwd, "tools", process.platform === "win32" ? "gdb.cmd" : "gdb");
	await writeExecutable(dbgengCmd);
	await writeExecutable(gdbCmd);
	await writeNativeAdapterOverrides(cwd, {
		"dap-dbgeng": dbgengCmd,
		gdb: gdbCmd,
		"lldb-dap": path.join(cwd, "tools", "missing-lldb"),
	});
	const program = path.join(cwd, "app.exe");
	await fs.writeFile(program, "");

	const selected = withPlatform("win32", () =>
		requireSelectedAdapter(selectLaunchAdapter(program, cwd)),
	);
	expect(selected.name).toBe("dap-dbgeng");
	expect(selected.resolvedCommand).toBe(dbgengCmd);
});

it("does not force dap-dbgeng ahead of gdb for extensionless binaries on non-win32", async () => {
	const cwd = await makeTempDir("omp-dap-dbgeng-nonwin-");
	const dbgengCmd = path.join(cwd, "tools", "dap-dbgeng");
	const gdbCmd = path.join(cwd, "tools", "gdb");
	await writeExecutable(dbgengCmd);
	await writeExecutable(gdbCmd);
	await writeNativeAdapterOverrides(cwd, {
		"dap-dbgeng": dbgengCmd,
		gdb: gdbCmd,
	});
	const program = path.join(cwd, "a.out");
	await writeExecutable(program);

	const selected = withPlatform("linux", () =>
		requireSelectedAdapter(selectLaunchAdapter(program, cwd)),
	);
	expect(selected.name).toBe("gdb");
});

it("prefers dap-dbgeng for PID attach on win32 when no port is given", async () => {
	const cwd = await makeTempDir("omp-dap-dbgeng-attach-");
	const dbgengCmd = path.join(cwd, "tools", process.platform === "win32" ? "dap-dbgeng.cmd" : "dap-dbgeng");
	const gdbCmd = path.join(cwd, "tools", process.platform === "win32" ? "gdb.cmd" : "gdb");
	await writeExecutable(dbgengCmd);
	await writeExecutable(gdbCmd);
	await writeNativeAdapterOverrides(cwd, {
		"dap-dbgeng": dbgengCmd,
		gdb: gdbCmd,
	});

	const selected = withPlatform("win32", () => selectAttachAdapter(cwd));
	expect(selected?.name).toBe("dap-dbgeng");
});

it("keeps debugpy preference for attach when a port is provided on win32", async () => {
	const cwd = await makeTempDir("omp-dap-dbgeng-attach-port-");
	const dbgengCmd = path.join(cwd, "tools", process.platform === "win32" ? "dap-dbgeng.cmd" : "dap-dbgeng");
	const debugpyCmd = path.join(cwd, "tools", process.platform === "win32" ? "python.cmd" : "python");
	await writeExecutable(dbgengCmd);
	await writeExecutable(debugpyCmd);
	await writeNativeAdapterOverrides(cwd, {
		"dap-dbgeng": dbgengCmd,
		debugpy: debugpyCmd,
	});

	const selected = withPlatform("win32", () => selectAttachAdapter(cwd, undefined, 5678));
	expect(selected?.name).toBe("debugpy");
});

it("reports explicit dap-dbgeng unavailable instead of falling back", async () => {
	const cwd = await makeTempDir("omp-dap-dbgeng-missing-");
	const missing = path.join(cwd, "tools", "dap-dbgeng-missing");
	await writeNativeAdapterOverrides(cwd, { "dap-dbgeng": missing });
	const program = path.join(cwd, "app.exe");
	await fs.writeFile(program, "");

	const selection = selectLaunchAdapter(program, cwd, "dap-dbgeng");
	expect(selection).toEqual({
		kind: "unavailable",
		adapterName: "dap-dbgeng",
		command: missing,
	});
});
```

Notes for the implementer:
- Partial `dap.json` overrides merge with built-ins (`mergeAdapters`), so overriding only `command` keeps `fileTypes` including `.exe`.
- `writeExecutable` already exists in this file.
- If non-win32 extensionless test is flaky because another adapter ranks higher, assert `selected.name !== "dap-dbgeng"` **and** that when both gdb and dap-dbgeng are available on linux, gdb wins — tighten only if needed after first run.

- [ ] **Step 2: Run selection tests to verify they fail**

Run:

```bash
bun test packages/coding-agent/test/debug/dap-config.test.ts -t "dap-dbgeng"
```

Expected: registry test PASS; selection preference tests FAIL (still `["gdb","lldb-dap"]` order / no win32 prefer).

- [ ] **Step 3: Implement platform-gated order helper**

In `packages/coding-agent/src/dap/config.ts`:

```ts
function getExtensionlessDebuggerOrder(): readonly string[] {
	return process.platform === "win32"
		? ["dap-dbgeng", "lldb-dap", "gdb"]
		: ["gdb", "lldb-dap"];
}
```

Replace all `EXTENSIONLESS_DEBUGGER_ORDER` references with `getExtensionlessDebuggerOrder()` and delete the old const.

Concrete call-site shapes:

```ts
// selectAutomaticLaunchAdapter filter
if (!getExtensionlessDebuggerOrder().includes(name) && !rootDir) continue;

// sortAdaptersForLaunch
const order = getExtensionlessDebuggerOrder();
const leftRank = order.indexOf(left.adapter.name);
const rightRank = order.indexOf(right.adapter.name);

// selectAttachAdapter
for (const preferred of getExtensionlessDebuggerOrder()) {
	const match = available.find(adapter => adapter.name === preferred);
	if (match) return match;
}
```

No changes to `resolveLaunchOverrides` unless a test proves host-injected field names break launch — session already spreads `adapter.launchDefaults` which include `stopAtEntry`.

- [ ] **Step 4: Run selection tests to verify they pass**

Run:

```bash
bun test packages/coding-agent/test/debug/dap-config.test.ts
```

Expected: all PASS, including new dap-dbgeng cases.

If a test fails because `withPlatform("win32")` does not affect order (module-load const leftover), fix remaining references.

If attach test fails because `getAvailableAdapters` also returns other PATH adapters that sort first, keep overrides using **absolute** command paths so only temp binaries resolve for those names; still possible other adapters exist. `selectAttachAdapter` walks preferred names and picks first **available** match — with dap-dbgeng first on win32 and our override resolvable, it should win even if gdb is also available.

- [ ] **Step 5: Commit (only if user requested commits)**

```bash
git add packages/coding-agent/src/dap/config.ts packages/coding-agent/test/debug/dap-config.test.ts
git commit -m "feat(coding-agent): prefer dap-dbgeng for Windows native debug selection"
```

---

### Task 3: Verification + anti-pattern audit

**Files:**
- Read-only verification across touched paths
- No new production code unless a gap is found

- [ ] **Step 1: Spec coverage checklist**

Confirm each spec requirement maps to code:

| Spec requirement | Where |
|---|---|
| Built-in `dap-dbgeng` entry | `defaults.json` |
| `stopAtEntry` not `stopOnEntry` | `defaults.json` + registry test |
| PATH-only discovery | no new resolver; uses `resolveCommand` |
| win32 launch prefer for `.exe` / extensionless | `getExtensionlessDebuggerOrder` + fileTypes |
| win32 attach prefer without port | same order in `selectAttachAdapter` |
| port still prefers debugpy | existing branch before preferred loop + test |
| explicit unavailable no silent fallback | existing `selectLaunchAdapter` explicit path + test |
| install hint | `ADAPTER_UNAVAILABLE_MESSAGES["dap-dbgeng"]` |
| tool/prompt mention | `debug.ts` describe + `debug.md` |
| changelog | `CHANGELOG.md` Unreleased Added |
| no mcp-windbg / dump / remote / kernel | no code paths added |

- [ ] **Step 2: Grep anti-patterns**

Run from repo root:

```bash
# must not introduce mcp-windbg / cdb text bridge for DAP
# (presence of the string only in design/plan docs is fine)

# ensure no module-level frozen win32 order
```

Use the search tool /:

```bash
bun -e "const fs=require('fs'); const s=fs.readFileSync('packages/coding-agent/src/dap/config.ts','utf8'); if(s.includes('const EXTENSIONLESS_DEBUGGER_ORDER')) { console.log('FAIL: module-level const still present'); process.exit(1);} if(!s.includes('getExtensionlessDebuggerOrder')) { console.log('FAIL: helper missing'); process.exit(1);} console.log('ok');"
```

Expected: `ok`.

Also confirm `defaults.json` has no `stopOnEntry` under `dap-dbgeng`.

- [ ] **Step 3: Full debug test slice**

Run:

```bash
bun test packages/coding-agent/test/debug/
```

Expected: all PASS.

- [ ] **Step 4: Manual smoke (optional, Windows host with real binary)**

Only when `dap-dbgeng` is on PATH and `dbgeng.dll` exists:

1. Launch via agent tool or a small script using `dapSessionManager.launch` with adapter resolved for `dap-dbgeng` and a PDB-bearing test `.exe`.
2. Confirm stop at entry or breakpoint, `stack_trace`, `terminate`.

Not required for CI green.

- [ ] **Step 5: Final commit (only if user requested commits)**

```bash
git add packages/coding-agent/src/dap/defaults.json packages/coding-agent/src/dap/config.ts packages/coding-agent/src/tools/debug.ts packages/coding-agent/src/prompts/tools/debug.md packages/coding-agent/test/debug/dap-config.test.ts packages/coding-agent/CHANGELOG.md
git commit -m "feat(coding-agent): add Windows dap-dbgeng DAP adapter support"
```

(Skip if Task 1/2 already committed the same tree.)

---

## Self-review (plan vs spec)

1. **Spec coverage:** Registry, selection, unavailable hint, docs, changelog, non-goals all have tasks. Dump/remote/kernel/MCP intentionally absent.
2. **Placeholders:** None — concrete JSON, helper body, and tests included.
3. **Type consistency:** Adapter id always `dap-dbgeng`; order helper name `getExtensionlessDebuggerOrder`; selection APIs unchanged externally.
4. **TDD order:** Task 1 registry test → defaults; Task 2 selection tests → order helper.
5. **Risk residual:** Live binary smoke is optional; CI proves contracts only.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-08-windows-dap-dbgeng.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
