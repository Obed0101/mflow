// ─── Sync Engine Core ───────────────────────────────────────
//
// packages/daemon — the core sync engine for Mflow.
// Watches files, manages CRDTs, and syncs changes with peers.

export { CRDTManager, type TrackedFile, type CRDTManagerEvents, type ICRDTPersistence } from "./crdt.js";
export { FileWatcher, WriteRegistry, type FileWatcherEvents, type FileWatcherOptions } from "./watcher.js";
export { ManifestManager, type ManifestEvents } from "./manifest.js";
export { CRDTPersistence } from "./persistence.js";
export { AwarenessManager, type AwarenessManagerEvents, type AwarenessManagerOptions } from "./awareness.js";
export { GitDetector, type GitDetectorEvents } from "./git.js";
export { SyncOrchestrator, type SyncOrchestratorEvents, type SyncOrchestratorOptions, type SyncStats } from "./sync.js";
export { IPCServer, type IPCServerOptions, type IPCHandler } from "./ipc.js";
export { MflowDaemon, type DaemonOptions, type DaemonEvents } from "./daemon.js";
export { WeriftTransport, type WeriftTransportOptions } from "./transport.js";
