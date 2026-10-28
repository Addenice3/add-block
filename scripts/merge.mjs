// Merges host-only rules into requestDomains rules, and checks that the
// merge changes nothing about what is matched.
//
// "||host^" matches that host and its subdomains on any path, port and
// scheme, which is exactly what requestDomains: [host] matches. Rules that
// differ only in that host (same action, priority and other conditions) are
// folded into one rule listing all the hosts. IP addresses and single-label
// hosts are left alone.

const HOST_ONLY = /^\|\|((?:[a-z0-9-]+\.)+[a-z0-9-]*[a-z][a-z0-9-]*)\^$/;
const MERGEABLE_ACTIONS = new Set(["block", "allow"]);
const MERGEABLE_KEYS = new Set([
  "urlFilter",
  "domainType",
  "resourceTypes",
  "excludedResourceTypes",
  "initiatorDomains",
  "excludedInitiatorDomains",
  "requestMethods",
  "excludedRequestMethods",
]);

// JSON with object keys sorted at every level, so that two rules that mean
// the same thing compare equal as strings.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function mergeHostRules(rules) {
  const out = [];
  const groups = new Map();
  for (const rule of rules) {
    const host = HOST_ONLY.exec(rule.condition.urlFilter ?? "")?.[1];
    const mergeable =
      host && MERGEABLE_ACTIONS.has(rule.action.type) && Object.keys(rule.condition).every((key) => MERGEABLE_KEYS.has(key));
    if (!mergeable) {
      out.push(rule);
      continue;
    }
    const { urlFilter, ...rest } = rule.condition;
    const key = `${rule.priority}|${canonical(rule.action)}|${canonical(rest)}`;
    let group = groups.get(key);
    if (!group) {
      group = { hosts: new Set(), rule: { priority: rule.priority, condition: rest, action: rule.action } };
      groups.set(key, group);
      out.push(group.rule);
    }
    group.hosts.add(host);
  }
  for (const { hosts, rule } of groups.values()) {
    const [first] = hosts;
    rule.condition =
      hosts.size === 1
        ? { urlFilter: `||${first}^`, ...rule.condition }
        : { ...rule.condition, requestDomains: [...hosts].sort() };
  }
  return out;
}

// The inverse of mergeHostRules: one "||host^" rule per listed host. Rule
// ids are dropped, because they are assigned after merging.
export function expandMergedRules(rules) {
  const out = [];
  for (const { id, ...rule } of rules) {
    const { requestDomains, ...rest } = rule.condition;
    if (!requestDomains || rule.condition.urlFilter) {
      out.push(rule);
      continue;
    }
    for (const host of requestDomains) {
      out.push({ ...rule, condition: { urlFilter: `||${host}^`, ...rest } });
    }
  }
  return out;
}

// Throws unless expanding the merged rules gives back exactly the unmerged
// rules (as a multiset; order does not matter for matching, see below).
// Priority decides between rules that match the same request, and every
// merged rule keeps its priority, so the order of equal-priority rules is
// the only thing the merge changes. Chrome documents no tie-break between
// equal-priority rules of the same action, and block/allow conflicts are
// decided by priority alone (allow wins ties), so order cannot change an
// outcome.
export function assertMergeEquivalent(unmerged, merged, label) {
  const count = (rules) => {
    const map = new Map();
    for (const rule of rules) {
      const key = canonical(rule);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  };
  const expected = count(unmerged.map(({ id, ...rule }) => rule));
  const actual = count(expandMergedRules(merged));
  const problems = [];
  for (const [key, n] of expected) {
    if (actual.get(key) !== n) problems.push(`missing after merge (${n} expected, ${actual.get(key) ?? 0} found): ${key}`);
  }
  for (const [key, n] of actual) {
    if (!expected.has(key)) problems.push(`added by merge (${n}): ${key}`);
  }
  if (problems.length) {
    throw new Error(`${label}: merged rules do not match the unmerged conversion:\n  ${problems.slice(0, 10).join("\n  ")}`);
  }
}
