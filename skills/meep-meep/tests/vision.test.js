import test, { is, ok } from 'tst';
import * as visionMod from '../scripts/vision.js';

const vision = visionMod.default || visionMod;

test('a screenshot is scaled to kev.js pixel cap and never up', () => {
  const big = vision.fitSize(2400, 2558);
  ok(big.width * big.height <= vision.MAX_PIXELS);
  ok(Math.abs(big.width / big.height - 2400 / 2558) < 0.01, 'the aspect ratio is kept');
  is(vision.fitSize(640, 480), { width: 640, height: 480, scale: 1 });
});

test('marks cover the on-screen menu controls once, in image pixels', () => {
  const el = (token, box) => ({ token, box, role: 'button', label: token });
  const menu = [
    { id: 'click:e1', element: el('e1', [100, 50, 200, 40]) },
    { id: 'type:e2:A', element: el('e2', [10, 10, 100, 20]) },
    { id: 'type:e2:B', element: el('e2', [10, 10, 100, 20]) },
    { id: 'click:e3', element: el('e3', [10, 2000, 100, 20]) },
    { id: 'click:e4', element: el('e4', [0, 0, 0, 0]) },
    { id: 'click:e5', element: el('e5', null) },
    { id: 'WAIT' },
  ];
  const marks = vision.layoutMarks(menu, { width: 1200, height: 800 }, { width: 600, height: 400 });
  is(
    marks.map((m) => m.label),
    ['e1', 'e2']
  );
  is(marks[0], { label: 'e1', x: 50, y: 25, w: 100, h: 20 });
  is(vision.layoutMarks(menu, null, { width: 600, height: 400 }), [], 'no viewport, no marks');
});

test('markedImage says what the worker lacks instead of failing deep inside', async () => {
  let message = '';
  try {
    await vision.markedImage(new Uint8Array(1), [], { width: 1, height: 1 }, {});
  } catch (err) {
    message = err.message;
  }
  ok(message.includes('createImageBitmap'));
});
