# Signal Desktop DOM surface (discovered)

Target: `file:///Applications/Signal.app/Contents/Resources/app.asar/background.html`

## Navigation

- Tabs: `[data-testid="NavTabsItem--Chats|Calls|Stories|Settings"]`
- Chats unread badge: `.NavTabs__ItemUnreadBadge` / `.NavTabs__ItemIconLabel`
- Left pane root: `#LeftPane` / `.module-left-pane`
- Search box: `textbox "Search"` / `.module-SearchInput__input`

## Conversation list

Selector:

```text
button.module-conversation-list__item--contact-or-conversation
```

Attributes:

- `data-id` — conversation UUID (internal)
- `data-testid` — stable service id (UUID or base64)
- `aria-label` — `"Chat with X, N new messages, last message: Y."`

Child structure:

- name: `.module-conversation-list__item--contact-or-conversation__content__header__name__contact-name`
- time: `.module-conversation-list__item--contact-or-conversation__content__header__date`
- preview: `.module-conversation-list__item--contact-or-conversation__content__message__text`
- unread pill: `.module-conversation-list__item--contact-or-conversation__unread-indicator--unread-messages`

List is React-Virtualized (`.ReactVirtualized__List`) — only viewport rows exist in the DOM.

## Open conversation

- Root: `.ConversationView`
- Header title: `.module-ConversationHeader__header__info__title`
- Timeline: `.module-timeline` / `.module-timeline__messages`
- Message bubble: `.module-message`
  - `.module-message--incoming` / `--outgoing`
  - author: `.module-message__author`
  - body: `.module-message__text`
  - time: `.module-message__metadata__date` (`datetime` attr when present)
  - wrapper: `.module-message__wrapper[role=article]`
  - `data-testid` on `.module-message` is a numeric timestamp-like id

## Composer

- Area: `.ConversationView__composition-area` / `.CompositionArea`
- Input chrome: `[data-testid="CompositionInput"]`
- Editor: `.ql-editor` (`contenteditable="plaintext-only"`, placeholder "Message")
- Quill root: `.module-composition-input__quill`
- Empty state class: `.ql-blank` on the editor
- No stable Send button — empty composer shows "Start recording voice message";
  with text the mic control hides. **Enter sends.**

## Text hygiene

Signal wraps names in bidi isolates U+2068 / U+2069. Strip with
`/[\u2066-\u2069]/g` before display or match.

## What is NOT available

- `window.Signal`, `window.SignalContext`, `window.reduxStore`
- `window.ConversationController`, `window.textsecure`, `window.Whisper`
- Readable React fiber keys from the CDP eval realm
- IndexedDB databases at the `file://` origin from this context
- Direct sqlcipher access
