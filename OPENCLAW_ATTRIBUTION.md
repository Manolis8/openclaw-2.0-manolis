# OpenClaw Attribution

This project uses code from [OpenClaw](https://github.com/openclaw/openclaw):

- **Tool Loop Detection** (`src/agents/tool-loop-detection.ts`)
- **Message Compaction** (`src/agents/compaction.ts`)
- **System Prompt Builder** (`src/agents/system-prompt.ts`)

OpenClaw is licensed under the MIT License.
See: https://github.com/openclaw/openclaw/blob/main/LICENSE

**What was changed:**
- Integrated directly into browser agent loop
- Removed OpenClaw-specific dependencies (@mariozechner packages)
- Used for token management and loop detection

**Original Author:** OpenClaw Contributors
**License:** MIT