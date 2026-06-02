# pi-coms task runner. Run `just` with no args to list recipes.
# API keys load from .env automatically (Pi reads them from the shell env).
set dotenv-load := true

# List available recipes
default:
    @just --list

# Install dev/peer deps for editor types (bun)
install:
    bun install

# Typecheck the extensions
typecheck:
    bun run typecheck

# --- Peer-to-peer (coms): direct Unix sockets, no broker -------------------

# Launch a peer-to-peer agent. Usage: just coms planner "Plans the work"
coms name purpose="general Pi agent":
    pi -e extensions/coms.ts --coms-name {{name}} --coms-purpose "{{purpose}}"

# Two convenient named seats
coms-planner:
    pi -e extensions/coms.ts --coms-name planner --coms-purpose "Plans the work"
coms-coder:
    pi -e extensions/coms.ts --coms-name coder --coms-purpose "Writes the code"

# --- Specialized seats: persona via --append-system-prompt (personas/*.md) --
# Builders run on Sonnet with full tools; reviewers (architect, security) run on
# Opus with high thinking and a restricted tool set (read + bash + the coms_*
# tools) so they inspect and advise but have no edit/write tool. NOTE: --tools is
# an allowlist that also gates extension tools, so the coms_* tools MUST be listed
# explicitly or the seat cannot communicate.

# Developer — implements features & fixes, full tools (Sonnet)
coms-developer:
    pi -e extensions/coms.ts --coms-name developer \
       --coms-purpose "Implements features and fixes bugs" \
       --model anthropic/claude-sonnet-4-6 \
       --append-system-prompt personas/developer.md

# Architect — designs & plans, restricted tools, deep thinking (Opus)
coms-architect:
    pi -e extensions/coms.ts --coms-name architect \
       --coms-purpose "Designs systems and plans work; does not edit code" \
       --model anthropic/claude-opus-4-7 --thinking high \
       --tools read,bash,coms_list,coms_send,coms_get,coms_await \
       --append-system-prompt personas/architect.md

# QA Engineer — writes & runs tests, reports failures, full tools (Sonnet)
coms-qa:
    pi -e extensions/coms.ts --coms-name qa-engineer \
       --coms-purpose "Writes and runs tests; reports actionable failures" \
       --model anthropic/claude-sonnet-4-6 \
       --append-system-prompt personas/qa-engineer.md

# Security — adversarial review, restricted tools, deep thinking (Opus)
coms-security:
    pi -e extensions/coms.ts --coms-name security \
       --coms-purpose "Finds vulnerabilities and proposes fixes; does not edit code" \
       --model anthropic/claude-opus-4-7 --thinking high \
       --tools read,bash,coms_list,coms_send,coms_get,coms_await \
       --append-system-prompt personas/security.md

# Infra / Cloud Engineer — CI/CD, IaC, deploy & cloud, full tools (Sonnet)
coms-infra:
    pi -e extensions/coms.ts --coms-name infra \
       --coms-purpose "Owns build, CI/CD, infra-as-code, and cloud resources" \
       --model anthropic/claude-sonnet-4-6 \
       --append-system-prompt personas/infra.md

# --- Hub-and-spoke (coms-net): central broker, broadcast, one audit log ----

# Start the local hub broker (run from your project dir; Ctrl+C to stop)
hub:
    bun scripts/coms-net-hub.ts

# Launch a hub-connected agent. Usage: just net planner "Plans the work"
net name purpose="general Pi agent":
    pi -e extensions/coms-net.ts --coms-name {{name}} --coms-purpose "{{purpose}}"

# Two convenient named seats (start `just hub` first, in another terminal)
net-planner:
    pi -e extensions/coms-net.ts --coms-name planner --coms-purpose "Plans the work"
net-coder:
    pi -e extensions/coms-net.ts --coms-name coder --coms-purpose "Writes the code"

# --- Specialized hub seats: same personas, hub transport (start `just hub` first)
# Reviewers' allowlist lists the coms_net_* tools explicitly (see the coms-* note).

# Developer — implements features & fixes, full tools (Sonnet)
net-developer:
    pi -e extensions/coms-net.ts --coms-name developer \
       --coms-purpose "Implements features and fixes bugs" \
       --model anthropic/claude-sonnet-4-6 \
       --append-system-prompt personas/developer.md

# Architect — designs & plans, restricted tools, deep thinking (Opus)
net-architect:
    pi -e extensions/coms-net.ts --coms-name architect \
       --coms-purpose "Designs systems and plans work; does not edit code" \
       --model anthropic/claude-opus-4-7 --thinking high \
       --tools read,bash,coms_net_list,coms_net_send,coms_net_broadcast,coms_net_get,coms_net_await \
       --append-system-prompt personas/architect.md

# QA Engineer — writes & runs tests, full tools (Sonnet)
net-qa:
    pi -e extensions/coms-net.ts --coms-name qa-engineer \
       --coms-purpose "Writes and runs tests; reports actionable failures" \
       --model anthropic/claude-sonnet-4-6 \
       --append-system-prompt personas/qa-engineer.md

# Security — adversarial review, restricted tools, deep thinking (Opus)
net-security:
    pi -e extensions/coms-net.ts --coms-name security \
       --coms-purpose "Finds vulnerabilities and proposes fixes; does not edit code" \
       --model anthropic/claude-opus-4-7 --thinking high \
       --tools read,bash,coms_net_list,coms_net_send,coms_net_broadcast,coms_net_get,coms_net_await \
       --append-system-prompt personas/security.md

# Infra / Cloud Engineer — CI/CD, IaC, deploy & cloud, full tools (Sonnet)
net-infra:
    pi -e extensions/coms-net.ts --coms-name infra \
       --coms-purpose "Owns build, CI/CD, infra-as-code, and cloud resources" \
       --model anthropic/claude-sonnet-4-6 \
       --append-system-prompt personas/infra.md
