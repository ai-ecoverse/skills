# Vendored dependencies

Copied verbatim from an `ipk install` of the pinned versions, so `./build.sh` needs no network.
Do not edit these files; refresh them with the command in ../../README.md and re-run the gate.

| file            | package   | version | sha256 |
| --------------- | --------- | ------- | ------ |
| marked.esm.js   | marked    | 18.0.14 | 528a1b88bef88fc27277e06036ce7f4afb6a220b18110ba57c09e292b24a7ce0 |
| purify.es.mjs   | dompurify | 3.4.15  | e7d8182ea0aae9daa46c3294a486067b3f4461bd18f8ca76e499c623e9bda6e3 |

Provenance: `ipk install marked@18.0.14 dompurify@3.4.15`, then
`node_modules/marked/lib/marked.esm.js` and `node_modules/dompurify/dist/purify.es.mjs`.

Why both: marked turns markdown into HTML, DOMPurify decides what of that HTML may exist.
Neither is load-bearing on its own — see the four layers documented at the top of
../markdown.js, and the note there about why images are dropped rather than sanitised.
