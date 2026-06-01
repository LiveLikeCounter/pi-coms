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
