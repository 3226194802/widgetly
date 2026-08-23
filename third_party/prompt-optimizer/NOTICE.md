# Prompt Optimizer integration notice

Widgetly includes a locally built Web distribution of Prompt Optimizer v2.11.8.

- Upstream project: https://github.com/linshenkx/prompt-optimizer
- Upstream tag: `v2.11.8`
- Upstream commit: `08b5531b39531bb41cf92fbba9a99412f26805cb`
- Upstream copyright: Copyright (C) 2025 linshenkx
- License: GNU Affero General Public License v3.0 only (`AGPL-3.0-only`)

Widgetly modifications: a narrow `postMessage` bridge lets the quick component open the Basic User workspace, select one of three upstream templates, start an optimization, receive the plain-text result, and open model management directly. The text-model form also exposes the provider model ID as a normal editable field, while retaining upstream model suggestions, so OpenAI-compatible and privately deployed model names can be entered explicitly. The complete workbench remains available and is loaded only on demand.

The unmodified license text is included at `licenses/AGPL-3.0.txt`. The corresponding source for the upstream version is available from the upstream repository and release tag. Widgetly's integration patch is stored next to this notice.
