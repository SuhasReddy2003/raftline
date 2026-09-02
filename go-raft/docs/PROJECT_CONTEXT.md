# Raftline — Project Context

## What is this?

Raftline is a live, interactive visualization of the Raft consensus algorithm — the algorithm real distributed databases (etcd, CockroachDB) and coordination systems (Kubernetes) use to keep multiple servers agreed on a single source of truth, even when individual servers fail.

The core algorithm is implemented in Go and compiled to WebAssembly, running entirely in the browser — no backend server required.

## Why build this

Most portfolio projects are CRUD apps or thin AI API wrappers. A correct implementation of a real, hard, well-known distributed systems algorithm — visualized live, not just described — is a genuinely uncommon and technically credible portfolio piece.

## Scope

### Implemented (real, faithful to the Raft paper)
- Leader election: randomized timeouts, term numbers, vote requests/responses
- Heartbeats: leader-to-follower liveness signal
- Log replication: writes propagate to a majority before being considered committed
- Safety: election restriction (a node won't vote for a less up-to-date candidate), commit index rules
- Simulated network partitions and node failures

### Explicitly out of scope (documented, not hidden)
- Cluster membership changes (adding/removing nodes at runtime) — real Raft's joint consensus protocol for this is notably complex; skipping it is a standard, defensible simplification for a demo
- Log compaction / snapshotting — only relevant for long-running production clusters, not a browser demo
- Persistent disk storage — nodes are simulated in-memory within a single browser tab

## Architecture

- `go-raft/` — the Raft implementation in Go, compiled to WebAssembly (`GOOS=js GOARCH=wasm`)
- Frontend (Next.js/React) — calls into the WASM module, renders the live cluster visualization
- No backend server — fully static, deployable on Vercel's free tier

## Target experience

A visitor opens the site and immediately sees an animated cluster of 5 nodes electing a leader. They can:
- Click "Kill Leader" and watch the cluster detect the failure and elect a new leader live
- Submit a "write" and watch it replicate across nodes with visual acknowledgment
- Trigger a network partition and watch the algorithm correctly prevent split-brain (two leaders)
- View a side panel showing real algorithm state (term, votes, log) to verify correctness

## Status

Planning / Discovery — Go module initialized, scope defined.