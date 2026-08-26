# Decisions

## 2026-08-26 — AGX hosts the API Relay, not a fleet controller

AGX will provide a small `agx relay` runtime that exposes the CC Switch
upstream to trusted LAN Agent clients. The Windows Go bridge remains the
upstream connector. Hermes, OMP, Multica scheduling, device orchestration, and
provider failover remain outside AGX Relay.

The v1 interface is `/health`, `/v1/models`, and `/v1/chat/completions` with
optional bearer authentication. API keys are not part of AGX state; callers
configure the upstream outside AGX and AGX never persists credentials.
