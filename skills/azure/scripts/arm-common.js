// arm-common.js — what az and az-ext must agree on. Pure: no sliccy:*, no I/O.

const ARM_HOST = 'management.azure.com';

/** A stored or harvested ARM token closer than this to expiry counts as absent. */
const EXPIRY_SKEW_SECONDS = 120;

/**
 * The only URLs the ARM bearer token may be sent to: https on management.azure.com.
 * Anything else (another host, plain http, a userinfo trick) returns null.
 */
function armUrl(pathOrUrl, base = `https://${ARM_HOST}`) {
  const raw = String(pathOrUrl || '');
  let u;
  try {
    u = new URL(
      /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : base + (raw.startsWith('/') ? '' : '/') + raw
    );
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== ARM_HOST || u.username || u.password || u.port)
    return null;
  return u.toString();
}

/** Resolve `<id|name>` (case-insensitive name, exact or unique prefix of a
 *  GUID) to a subscription record; null when nothing or more than one matches. */
function resolveSubscription(subs, wanted) {
  const needle = String(wanted).trim();
  const lower = needle.toLowerCase();
  const byId = subs.find((s) => String(s.id).toLowerCase() === lower);
  if (byId) return byId;
  const byName = subs.filter((s) => String(s.name).toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return null;
  const partial = subs.filter(
    (s) =>
      String(s.name).toLowerCase().includes(lower) || String(s.id).toLowerCase().startsWith(lower)
  );
  return partial.length === 1 ? partial[0] : null;
}

/** Why resolveSubscription returned null, for the error message. */
function subscriptionMatches(subs, wanted) {
  const lower = String(wanted).trim().toLowerCase();
  const byName = subs.filter((s) => String(s.name).toLowerCase() === lower);
  if (byName.length > 1) return byName;
  return subs.filter(
    (s) =>
      String(s.name).toLowerCase().includes(lower) || String(s.id).toLowerCase().startsWith(lower)
  );
}

module.exports = {
  ARM_HOST,
  EXPIRY_SKEW_SECONDS,
  armUrl,
  resolveSubscription,
  subscriptionMatches,
};
