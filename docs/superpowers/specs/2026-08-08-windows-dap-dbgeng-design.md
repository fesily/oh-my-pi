# Windows Native DAP Adapter (dap-dbgeng) — Design

**Date:** 2026-08-08  
**Status:** Approved for implementation planning  
**Package:** `packages/coding-agent`  
**Scope:** v1 — local launch + attach-by-PID via external DAP adapter

## Problem

oh-my-pi’s debug stack (`packages/coding-agent/src/dap/`) is a pure DAP client.
Built-in adapters live in `defaults.json` as command/args configs (gdb, lldb-dap,
debugpy, dlv, …). There is **no** Windows native adapter:

- no `cdb` / WinDbg / `cppvsdbg` / `dap-dbgeng` entry
- no win32-aware selection for `.exe` or PID attach
- no dump/remote/kernel path in the DAP tool surface

On Windows, native C/C++ debugging therefore falls through to gdb/lldb (if
present) or fails entirely.

## Non-goals (v1)

| Out of scope | Why |
|---|---|
| mcp-windbg integration | MCP text CLI over cdb/kd; crash triage, not DAP breakpoints/step/vars |
| Bundling or auto-downloading dap-dbgeng | User installs binary on PATH (same model as gdb/lldb) |
| VS Code extension directory scanning | Explicitly deferred; PATH-only discovery |
| Crash dump open (`dumpFile`) | Adapter supports it; OMP tool surface not extended yet |
| Remote `dbgsrv` / `connectionString` | Same |
| Kernel attach | Same |
| Host-side CDB text→DAP translator | Would fight the pure-DAP architecture; dap-dbgeng already exists |

## Related external projects

| Project | Role vs this design |
|---|---|
| [svnscha/dap-dbgeng](https://github.com/svnscha/dap-dbgeng) (MIT) | **Chosen backend.** C++20 DAP server over `dbgeng.dll`. Launch, attach-by-PID, dump, remote, kernel. |
| [svnscha/mcp-windbg](https://github.com/svnscha/mcp-windbg) (MIT) | Orthogonal. Optional future MCP for dump/`!analyze` triage; **not** used for v1 DAP. |

## Decision summary

1. **Protocol path:** DAP only — register an external adapter, do not translate CDB text.
2. **Backend:** `dap-dbgeng` (user-provided binary on PATH).
3. **Registration model:** same as existing adapters — JSON entry in `defaults.json`, no new TypeScript adapter class.
4. **v1 scenarios:** local `launch` of an executable + local `attach` by `processId`.
5. **Platform gating:** selection priority changes are **win32-only** so Linux/macOS gdb/lldb behavior is unchanged.

## Architecture

```
debug tool (tools/debug.ts)
  → selectLaunchAdapter / selectAttachAdapter   # win32 prefers dap-dbgeng when available
  → defaults.json["dap-dbgeng"]
  → resolveAdapter (PATH → dap-dbgeng[.exe])
  → DapClient (stdio, Content-Length DAP)
  → dap-dbgeng.exe
  → dbgeng.dll (Windows SDK Debugging Tools)
```

No new process protocol. No Python dependency. No MCP server spawn for debug sessions.

## Built-in adapter config

Add to `packages/coding-agent/src/dap/defaults.json`:

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
  "connectMode": "stdio",
  "launchDefaults": {
    "request": "launch",
    "stopAtEntry": true
  },
  "attachDefaults": {
    "request": "attach"
  }
}
```

### Field notes

| Field | Choice | Rationale |
|---|---|---|
| key / adapter id | `dap-dbgeng` | Matches binary and project name; distinct from VS Code debug type `dbgeng` |
| `command` | `dap-dbgeng` | Resolved via existing `resolveCommand` (PATH / local bins) |
| `connectMode` | `stdio` (default) | dap-dbgeng speaks DAP on stdio like gdb/lldb-dap |
| `stopAtEntry` | true in launchDefaults | **dap-dbgeng schema** uses `stopAtEntry`, not gdb’s `stopOnEntry` |
| `fileTypes` includes `.exe` | yes | Auto-select for Windows binaries without forcing adapter param |
| `rootMarkers` | MSVC + CMake markers | Prefer this adapter in VS/CMake native trees when available |
| `languages` | c, cpp | Rust/Zig stay on lldb/gdb/codelldb unless user forces adapter |

### Launch/attach argument mapping

Host already injects common fields (`program`, `cwd`, `args`, `processId` / `pid` mapping as implemented by `DapSessionManager`). v1 relies on that path:

- **Launch:** `program`, optional `args`, `cwd`, plus `stopAtEntry` from defaults.
- **Attach:** `processId` from tool `pid` (existing attach path). No `connectionString`, `kernel`, or `dumpFile` in v1 tool args.

If session-layer field names diverge from dap-dbgeng (e.g. host sends `stopOnEntry` only), fix with a **narrow** `resolveLaunchOverrides` branch for `adapter.name === "dap-dbgeng"` — do not invent a general rename layer.

## Selection logic (win32 only)

### Launch (`selectLaunchAdapter` / `sortAdaptersForLaunch` / extensionless order)

Today:

```ts
const EXTENSIONLESS_DEBUGGER_ORDER = ["gdb", "lldb-dap"];
```

v1 change (conceptual):

```ts
// win32: prefer native dbgeng when present
// non-win32: unchanged
const EXTENSIONLESS_DEBUGGER_ORDER =
  process.platform === "win32"
    ? ["dap-dbgeng", "lldb-dap", "gdb"]
    : ["gdb", "lldb-dap"];
```

Also ensure automatic selection:

1. Explicit `adapter: "dap-dbgeng"` always wins (existing behavior).
2. Extension match: `.exe` → dap-dbgeng when available (via `fileTypes`).
3. Extensionless PE / binary on win32 → order above.
4. Source `.c/.cpp` with available dap-dbgeng and MSVC/CMake root markers → natural fileTypes/rootMarkers ranking (no special-case beyond registration if sorting already prefers matching markers; only add a sort tweak if tests show gdb always winning on win32 when both exist).

Unavailable configured adapter still returns `{ kind: "unavailable", ... }` with a clear install hint (see Errors).

### Attach (`selectAttachAdapter`)

Today: explicit name → else port prefers debugpy → else `EXTENSIONLESS_DEBUGGER_ORDER` → else first available.

v1:

- Keep port → debugpy preference (all platforms).
- On win32, when **no port** is given (typical PID attach), prefer `dap-dbgeng` before gdb/lldb by reusing the win32 extensionless order (or an explicit win32 preferred list that starts with `dap-dbgeng`).
- Non-win32 unchanged.

## Errors and user-facing install hint

When `dap-dbgeng` is selected (explicit or auto) but `resolveCommand` fails:

- Surface the existing unavailable-adapter path.
- Message should mention: install [dap-dbgeng](https://github.com/svnscha/dap-dbgeng) / VS Marketplace `svnscha.vscode-dap-dbgeng`, put `dap-dbgeng` on PATH, and ensure Debugging Tools for Windows (`dbgeng.dll`) is installed via Windows SDK.

Do **not** silently fall through to gdb after an explicit `adapter: "dap-dbgeng"` request.

## Tool / prompt surface

Minimal docs updates so the agent knows the id exists:

1. `packages/coding-agent/src/tools/debug.ts` — `adapter?` schema description includes `dap-dbgeng`.
2. `packages/coding-agent/src/prompts/tools/debug.md` — note Windows native adapter id and PATH requirement (keep short; no tutorial).
3. Optional example call for launching a Windows `.exe` with `adapter: "dap-dbgeng"`.

No new debug tool actions in v1.

## Tests

Prefer contract tests in `packages/coding-agent/test/debug/`:

| Contract | Assertion |
|---|---|
| Registry | `getAdapterConfigs()` includes `dap-dbgeng` with `command: "dap-dbgeng"` and `stopAtEntry` in launchDefaults |
| Launch selection win32 | With mocked available adapters including dap-dbgeng, selecting for `app.exe` yields dap-dbgeng |
| Launch selection non-win32 | Order for extensionless binaries still gdb then lldb-dap (no forced dap-dbgeng) |
| Attach selection win32 | No port + dap-dbgeng available → dap-dbgeng preferred |
| Explicit unavailable | `adapter: "dap-dbgeng"` when command missing → unavailable, not silent gdb |

CI must not require a real `dap-dbgeng.exe` or Windows Kits. Live smoke is manual on a Windows machine with the binary installed.

## Implementation touch points

| File | Change |
|---|---|
| `packages/coding-agent/src/dap/defaults.json` | Add `dap-dbgeng` entry |
| `packages/coding-agent/src/dap/config.ts` | Platform-gated preferred order; attach preference; optional `resolveLaunchOverrides` if field remap needed |
| `packages/coding-agent/src/tools/debug.ts` | Schema description + optional example |
| `packages/coding-agent/src/prompts/tools/debug.md` | One-line Windows note |
| `packages/coding-agent/test/debug/dap-config.test.ts` (and/or sibling) | Selection/registry contracts |
| `packages/coding-agent/CHANGELOG.md` | `[Unreleased]` → `### Added` entry |

## Future work (not v1)

1. **PATH + VS Code extension discovery** — scan `~/.vscode/extensions/svnscha.vscode-dap-dbgeng-*` for bundled adapter.
2. **Optional tools-manager download** — cache release binary under `~/.omp/`.
3. **Dump / remote / kernel** — extend debug tool attach args (`dumpFile`, `connectionString`, `kernel`) once local path is proven.
4. **mcp-windbg as MCP** — optional user/project `mcp.json` entry for dump triage; document only, do not bake into DAP.

## Risks

| Risk | Mitigation |
|---|---|
| Binary not on PATH (common if only VS Code extension installed) | Clear unavailable error + install docs; future discovery work |
| Schema drift (`stopAtEntry` vs `stopOnEntry`) | Explicit launchDefaults; targeted override if host injects wrong name |
| Selection steals Linux/macOS sessions | All priority changes gated on `process.platform === "win32"` |
| dap-dbgeng capability gaps | Pass through DAP only; document honest feature set from upstream |
| Root marker globs `*.sln` / `*.vcxproj` | Supported — `hasRootMarkers` already handles `*.…` (same as netcoredbg) |

## Success criteria

1. On Windows with `dap-dbgeng` on PATH, agent can `debug` launch a local `.exe` and stop at entry / breakpoints.
2. Agent can attach by PID with adapter auto-selected or explicit `dap-dbgeng`.
3. Without the binary, error names the missing adapter and how to install it.
4. Non-Windows adapter selection behavior is unchanged.
5. No mcp-windbg / Python / bundled native binary in the coding-agent package.
