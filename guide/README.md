# Official guidance goes here

`official-evidence.md` and `official-rules.md` are generated verbatim from the organisers' docs by `npm run sync-official`. Don't edit them; re-run the sync. `fair-play.md` is verbatim from the Pilot Terms.

Put the official competition texts in this folder as `.md` files, for example:

- `agent-guide.md`: the agent guide published on 23 Nov
- `one-line-prompt.md`: the one-line prompt from the competition site
- `faq.md`: anything else from Discord or the site worth following

Every `.md` file in this folder except this README is added to the research and fact-check
prompts as official guidance (see `src/lib/prompts.ts`). You don't need to change any code.
Keep these files to the organisers' own text.
