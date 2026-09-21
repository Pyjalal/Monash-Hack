# Shared dashboard and extension theme

Reading this as an operations workspace for shipping teams, with Talentbank's navy, ivory and editorial typography applied to existing task-focused layouts. Design variance 3, motion intensity 1, visual density 7. Existing React/Vite, Tailwind, shadcn-style controls and Lucide remain the component system.

Reference: https://www.talentbank.ai/, inspected through rendered computed styles on 21 September 2026. Albert Sans, Fraunces, navy #16284b, ivory #f7f6f2 and gold #e7ce93 were observed directly. Fraunces is used because the user explicitly requested this reference's typography. Gold is reserved for contrast-safe accents on navy. Operational success, mismatch and error colours retain separate meanings and text labels.

| Before | After | Why |
| --- | --- | --- |
| Dashboard system sans and cobalt; extension plum | Shared navy, warm ivory and locally packaged Albert Sans | One recognizable product across surfaces |
| Uniform sans display hierarchy | Fraunces for page and sign-in headings; sans for data | Reference typography without compromising table readability |
| Full variable display font, 195 KB | Instanced 600-weight Fraunces, 31 KB | Reduce font transfer while preserving the chosen display style |
| Serif inherited by extension subtitle | Albert Sans subtitle | Keep supporting instructions readable |
| Errors inherited primary accent | Explicit red errors with visible text | Preserve semantic distinction |

Validation: dashboard login and synthetic 520-case workspace inspected in browser; command dialog operates and traps focus. Extension settings inspected at desktop and 390px with no horizontal overflow. Static HTTP preview cannot use Chrome storage, so its expected settings error is not a live extension failure. Rebuilt extension bundles are ready for Chrome reload; this review does not claim a reload of the installed extension.

48 dashboard/extension tests pass. TypeScript checks and ESLint pass. Both production builds succeed. Main contrast pairs: muted text/ivory 5.58:1; action text/navy 14.46:1; gold/deep navy 10.06:1. These are measured colour pairs, not a full accessibility certification. The dashboard retains responsive layout and keyboard navigation. Fonts ship under bundled SIL licenses; content-script font loading uses a namespaced family with system fallbacks if mailbox policy blocks it. No new mailbox permissions or external font requests are introduced.
