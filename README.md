# @hanzo/control

The Hanzo control tool. One launcher, bottom corner of every Hanzo surface: change how the
page looks, change its language, get help, and suggest or edit the page you are on.

```html
<script async src="https://api.hanzo.ai/control.js"></script>
```

That is the whole integration. It is dependency-free vanilla JS in a shadow root, so
it renders the same on a Next export, a Vite app and a Django-served React app, and
neither side can restyle the other by accident.

## What the page declares

The widget reads its configuration from the page rather than from a call site, so a
static export can configure it too.

| meta                | required | meaning                                       |
| ------------------- | -------- | --------------------------------------------- |
| `hanzo:repo`        | yes      | `owner/repo` the page's source lives in       |
| `hanzo:path`        | no       | default file for an edit, when convention misses |
| `hanzo:branch`      | no       | defaults to `main`                             |
| `hanzo:provider`    | no       | defaults to `github`                           |
| `hanzo:key`         | no       | project key                                    |
| `hanzo:anchor`      | no       | selector to dock into, e.g. `#enso-dock`       |

Without `hanzo:anchor` the launcher floats in the corner. With it, the launcher moves
into that slot and the panel still opens from it. The slot is usually rendered by the
host framework after this script runs, so the widget watches for it rather than
querying once.

## Where it talks to

`BASE` is the origin the script itself was served from, so the backend follows the
host: serve `control.js` from `api.hanzo.ai` and it calls `api.hanzo.ai`. Routes used are
`/v1/edit`, `/v1/suggest`, `/v1/me`, `/v1/register` and `/v1/s`.

## Panes

The launcher opens one panel and the panel shows one pane at a time. Edit and suggest
are the panes that exist today. Appearance, language and help are the ones being added,
and each is a render into the same panel rather than a widget of its own.
