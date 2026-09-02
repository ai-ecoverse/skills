# Server-side tool calls must never be answered

**The single most important finding in this skill.** Getting this wrong
causes a real, hard-to-diagnose production bug: duplicate/truncated
assistant turns and the user's spoken answers silently never reaching the
transcript.

## The trap

xAI's realtime Speech-to-Speech API fires
`response.function_call_arguments.done` for **every** tool call, including
ones the server itself executes automatically. The published reference
docs say tools like `file_search`/`web_search`/`x_search`/`mcp` are
"executed automatically server-side... you don't need to handle their
responses" — but they do not warn you that the event you'd naturally use
to detect a tool call fires for these too, with the same event shape as a
genuine client-side function call.

**`file_search` arrives under the function name `collections_search`, not
`file_search`.** Naive code that checks "is this name one of my known
tools?" and treats everything else as `file_search`/an error will
misclassify this.

## What goes wrong if you answer it

If your code treats an unrecognized tool-call name as an error and sends
back a `function_call_output` (even an `{error: "..."}` one) and then, once
all in-flight tool calls are accounted for, calls `response.create` — you
have just sent an **unsolicited** `response.create` while the server was
already continuing its own search-triggered response.

Observed real-world consequences of this exact bug:
- The model's own answer gets duplicated or truncated mid-word (a
  re-emission under a new `item_id`).
- The user's in-flight spoken answer gets pre-empted server-side and never
  committed/transcribed — their audio was sent, it just never makes it into
  a turn, because the unsolicited response.create pre-empted their turn.
- An otherwise-unexplained multi-second gap between a user's question and
  the agent's reply (the server has to recover from an unexpected response
  in flight).

## The fix: an allow-list, not a deny-list

Check whether a tool-call name is one of **your own** declared
client-side function tools (an ALLOW-list), not whether it matches a known
server-side tool name (a deny-list). xAI can add new server-side tools at
any time without you finding out about it from a changelog — an allow-list
derived from your own `tools` array (only entries with `type: "function"`)
is correct regardless.

```js
// RealtimeSession, roughly:
setLocalFunctionNames(names) { this._localFunctionNames = new Set(names); }
isLocalFunction(name) { return this._localFunctionNames.has(name); }

// on response.function_call_arguments.done:
if (!this.isLocalFunction(event.name)) {
  this.onServerToolCall?.({ name: event.name, callId: event.call_id, arguments: event.arguments });
  break; // never touch in-flight-call bookkeeping, never send anything back
}
// ...only now proceed through the normal function_call_output -> settled -> response.create path
```

Derive the allow-list from the real tool array you built for the session
(e.g. `tools.filter(t => t.type === "function").map(t => t.name)`), never
a hardcoded list — a tool declared any other way silently falls through to
being treated as server-side and never gets answered, which is the correct
failure mode (nothing happens) rather than the original bug's failure mode
(something actively harmful happens).

## Verifying this against the live API

A regression test that proves both halves — a server-side tool call
produces **zero** outbound messages and never fires your "tool calls
settled" hook, while a genuine client-side function call still gets
answered correctly — is the only way to be confident this stays fixed.
Test against a real WebSocket connection with a fake/recording `send()`,
not a mock of the whole session object, so you're exercising the real
message-handling code path.

If you're testing in a `.jsh`/Node-like sandboxed runtime, verify first
that it can actually hold a WebSocket open across multiple real round
trips for several seconds — some restricted runtimes cannot do real async
I/O beyond ~1-2 seconds regardless of how the code is written, which will
make an otherwise-correct live-API test look broken. A basic `curl`/
`websocat`-based shell script is a reasonable fallback for exercising the
real protocol if your primary scripting runtime can't sustain the
connection.
