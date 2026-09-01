# ValeLoot Desktop - Architecture & Development Guidelines

## Project Overview
ValeLoot Desktop is a passive cross-platform Spirit Vale loot filter and ledger desktop application.
It intercepts and observes game inventory packets (via libpcap/dumpcap on Linux and Npcap on Windows), matches items against user-defined rule filters, and triggers audio/visual alerts.

## Tech Stack
- **Runtime & Package Manager**: Bun (`bun@1.4.0`)
- **Desktop Framework**: Electron (`44.1.0`)
- **Frontend UI**: Preact (`10.29.7`), TypeScript (`7.0.2`), CSS
- **Packaging**: `electron-builder`
- **Domain Libraries**: `@kar-mi/spirit-vale-tools-capture`, `@kar-mi/spirit-vale-tools-items`, `@kar-mi/spirit-vale-tools-market`

## Codebase Structure
- `src/electron/`: Electron main process, window management, lifecycle, IPC handlers.
- `src/frontend/`: Preact renderer UI components (bag view, rules editor, profile manager, diagnostic viewer, sounds).
- `src/backend/`: Packet capture collector process, LiteNetLib / FishNet stream reassembly, game state tracking.
- `src/shared/`: Shared models, types, filter parser/evaluator, IPC contracts.
- `src/build.ts`: Custom build orchestrator bundling Electron main, renderer, collector, and static assets.
- `test/`: Bun test suite (`bun test`).

## Key Development Commands
- `bun run setup`: Install dependencies.
- `bun run prepare` / `bun run build`: Compile and bundle Electron main, preload, renderer, and collector.
- `bun run dev`: Build and launch Electron app locally.
- `bun run typecheck`: Run TypeScript typechecking (`tsc --noEmit`).
- `bun run test`: Run the test suite (`bun test`).
- `bun run check`: Run typecheck + unit tests.
