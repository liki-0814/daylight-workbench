# Third-party notices

The root MIT license applies to Daylight's original code. Third-party code and
dependencies retain their own copyright notices and license terms.

| Component | Version | Use | License |
| --- | --- | --- | --- |
| [Marked](https://github.com/markedjs/marked) | 18.0.14 | Vendored browser Markdown parser in `public/components/marked.js` | [MIT and included Markdown notice](licenses/marked-LICENSE) |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.16 | Vendored browser HTML sanitizer in `public/components/purify.js` | [Apache-2.0 OR MPL-2.0](licenses/dompurify-LICENSE) |
| [Zod](https://github.com/colinhacks/zod) | 3.25.76 | npm dependency for schema validation | [MIT](licenses/zod-LICENSE) |
| [Qoder Agent SDK](https://docs.qoder.com/cli) | 1.0.39 | npm dependency for the local Qoder adapter | [Qoder Product Service Terms](licenses/qoder-agent-sdk-LICENSE) |

Vendored browser files preserve their upstream license headers. The `licenses/`
directory contains the license notices shipped with these versions. The Qoder
Agent SDK is not relicensed under Daylight's MIT license.

Other transitive dependencies are listed in `package-lock.json`; their license
files remain in their installed package directories. The macOS build preserves
the installed packages' license files and includes Daylight's notices.

Node.js, Codex CLI, Qoder CLI, Grok CLI and AGY are external installations. Their
licenses and service terms apply separately.
