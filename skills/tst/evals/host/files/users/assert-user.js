// Shared test helper: fails the current test unless `user` is a valid account record.
import { is, ok } from 'tst';

export function assertValidUser(user) {
  ok(user && typeof user === 'object', 'user must be an object');
  ok(typeof user.name === 'string' && user.name.length > 0, 'user needs a name');
  ok(/^[^@\s]+@[^@\s]+$/.test(user.email ?? ''), 'user needs an email');
  is(typeof user.age, 'number', 'age must be a number');
}
