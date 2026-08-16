# @hanzo/control

**Hanzo Control** is the controls surface for Hanzo apps and websites. It lets people
adjust their experience, get help, and contribute to the page they are viewing. The
actions on offer follow the visitor's permissions.

```html
<script async src="https://api.hanzo.ai/control.js"></script>
```

That is the whole integration. It is dependency-free vanilla JS in a shadow root, so it
renders the same on a Next export, a Vite app and a Django-served React app, and neither
side can restyle the other by accident.

## Vocabulary

One name per thing, everywhere: in this repo, in the apps, in the docs, and on a
customer's site.

| Concept                    | Say                            |
| -------------------------- | ------------------------------ |
| The product                | Hanzo Control                  |
| Package                    | `@hanzo/control`               |
| Repo                       | `hanzoai/control`              |
| Launcher tooltip           | Controls                       |
| Accessible label           | Open controls                  |
| Panel heading              | Controls                       |
| Visual settings            | Appearance                     |
| Locale                     | Language                       |
| Assistance                 | Help                           |
| Contribution, unauthorized | Suggest an edit                |
| Contribution, authorized   | Edit page                      |
| Deployment setting         | Show Controls                  |
| Its description            | Show Hanzo Control on this site |

**A visitor never sees the word Hanzo.** The product name belongs to the docs, the
package and the deployment setting. In the panel the surface is called Controls, so it
reads as part of whatever site it is on. This is the same rule that keeps Hanzo branding
off Lux and Zoo surfaces, and it is what lets someone deploy this on their own domain
without a rename.

## Permission replaces the slot, it does not add to it

| Visitor                       | Panel                                             |
| ----------------------------- | ------------------------------------------------- |
| Anonymous                     | Appearance · Language · Help · Suggest an edit    |
| Signed in, no edit permission | Appearance · Language · Help · Suggest an edit    |
| Editor or admin               | Appearance · Language · Help · Edit page          |

An editor never sees both Suggest an edit and Edit page. It is one slot with two
permissions, which is what stops the panel accumulating near-duplicate doors as
capabilities land.

The contextual action stays last even for an editor, who mostly came for it. A slot that
changes position by permission is a slot people have to find again, and the panel is
short.

## The panel

```
Controls

Appearance      System · Light · Dark
Language        English · …
Help            Get help

Suggest an edit   (or)   Edit page
```

There is no Feedback, Contribute, Page tools, Info, Site settings or Admin section.
Anything wrong with the page is a suggestion, and Help is one door out to support and
docs. A second door for page problems splits the same intent in two, and the reports
arrive in the wrong queue about half the time.

Admin is a different surface. Organization and project configuration, security, billing
and members are not in here and should not arrive later.

## What the page declares

Configuration is read from the page rather than from a call site, so a static export can
configure it too.

| meta               | required | meaning                                          |
| ------------------ | -------- | ------------------------------------------------ |
| `hanzo:repo`       | yes      | `owner/repo` the page's source lives in          |
| `hanzo:path`       | no       | default file for an edit, when convention misses |
| `hanzo:branch`     | no       | defaults to `main`                               |
| `hanzo:provider`   | no       | defaults to `github`                             |
| `hanzo:key`        | no       | project key                                      |
| `hanzo:anchor`     | no       | selector to dock into, for example `#enso-dock`  |

Without `hanzo:anchor` the launcher floats in the corner. With it, the launcher moves
into that slot and the panel still opens from it. The slot is usually rendered by the
host framework after this script runs, so the widget watches for it rather than querying
once.

## Deployment

```
Hanzo Control
  Show Controls          Show the Controls launcher to visitors.
    Appearance
    Language
    Help
    Suggest an edit
    Edit page
```

The capability toggles carry the same names the visitor sees, so an operator reading the
settings and a visitor reading the panel are talking about the same thing.

## Where it talks to

`BASE` is the origin the script itself was served from, so the backend follows the host:
serve `control.js` from `api.hanzo.ai` and it calls `api.hanzo.ai`. The routes used are
`/v1/edit`, `/v1/suggest`, `/v1/me`, `/v1/register` and `/v1/s`.

## Panes

The launcher opens one panel and the panel shows one pane at a time. Suggest an edit and
Edit page are the panes that exist today. Appearance, Language and Help are renders into
the same panel rather than widgets of their own.
