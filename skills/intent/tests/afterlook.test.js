// The look after an action, without --boxes (2026-10-04): a snapshot with
// boxes costs 2.5–3.5× one without, and the next call looks again anyway.
import test, { is, ok } from 'tst';
import * as snapshotMod from '../scripts/snapshot.js';
import * as tabMod from '../scripts/tab.js';

const page = snapshotMod.default || snapshotMod;
const { tabTools } = tabMod.default || tabMod;

const WITH_BOXES = [
  'Page URL: https://game.example/',
  '- rootwebarea',
  '  - link "Stories of the village" [ref=e1] [box=10,10,200,20]',
  '  - button "Save" [ref=e2] [box=300,10,40,20]',
  // A container whose name holds every button in it (Kittens' bonfire list).
  '  - listitem "Gather catnip Catnip Field Refine catnip" [ref=e3]',
].join('\n');
const WITHOUT_BOXES = WITH_BOXES.replace(/ \[box=[^\]]+\]/g, '');
// What the page scan finds: two div buttons, and a div wrapping the link.
const FOUND = [
  { t: 'Gather catnip', b: [10, 100, 120, 30] },
  { t: 'Refine catnip', b: [10, 140, 120, 30] },
  { t: 'Stories of the village (new)', b: [10, 10, 200, 20] },
];
const VIEWPORT = { width: 1280, height: 800, scrollY: 0, scrollHeight: 800 };
const synthetic = (shot) => shot.elements.filter((e) => e.synthetic).map((e) => `${e.token} ${e.label}`);

test('promoteClickable: with boxes, as before; without, the same controls by name', () => {
  const boxed = page.promoteClickable(page.parseSnapshot(WITH_BOXES), FOUND, VIEWPORT);
  is(synthetic(boxed), ['c1 Gather catnip', 'c2 Refine catnip']);
  // No boxes: the wrapper is matched to the link by its text, so the
  // c-refs an after-look shows are the ones the next look will have.
  const plain = page.promoteClickable(page.parseSnapshot(WITHOUT_BOXES), FOUND, VIEWPORT);
  is(synthetic(plain), ['c1 Gather catnip', 'c2 Refine catnip']);
});

test('afterLookBoxes: boxes only where the page has synthetic controls to number', () => {
  const plainPage = page.parseSnapshot(WITH_BOXES);
  is(page.afterLookBoxes(plainPage), false);
  const gamePage = page.promoteClickable(plainPage, FOUND, VIEWPORT);
  is(page.afterLookBoxes(gamePage), true);
});

test('observe: boxes: false takes the snapshot without --boxes, and still scans the page', async () => {
  const calls = [];
  const exec = {
    spawn: async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: WITHOUT_BOXES, stderr: '' };
    },
  };
  const evals = [];
  const evalJs = async (tab, expr) => {
    evals.push(expr.slice(0, 40));
    return expr.includes('innerWidth') ? JSON.stringify({ width: 1280, height: 800, scrollY: 0, scrollHeight: 800 }) : JSON.stringify({ clickable: [], disambiguation: [] });
  };
  const tools = tabTools({ exec, evalJs });
  await tools.observe('AB12', null, { viewport: true, boxes: false });
  is(calls[0], ['playwright-cli', 'snapshot', '--tab=AB12']);
  ok(evals.length >= 2, 'viewport and page scan still run');
  calls.length = 0;
  await tools.observe('AB12', null, { viewport: true });
  is(calls[0], ['playwright-cli', 'snapshot', '--tab=AB12', '--boxes']);
});
