// OpenMetadata: find tables in a Snowflake service that have lineage
// to/from another Snowflake table. Run from the OM UI's DevTools console.
//
// =============================================================================
// QUICK START — paste ONE of these one-liners into the OM browser console:
//
// (a) Use SERVICE_NAME hard-coded below:
//
//     fetch('https://raw.githubusercontent.com/ulixius9/code-samples/main/om_snowflake_lineage.js').then(r=>r.text()).then(eval)
//
// (b) Override the service name without editing the script:
//
//     window.OM_SF_SERVICE='your_snowflake_service';fetch('https://raw.githubusercontent.com/ulixius9/code-samples/main/om_snowflake_lineage.js').then(r=>r.text()).then(eval)
//
// (c) If you get 401 — the script couldn't auto-find your JWT. Copy your token
//     from OM UI: Settings -> Bots -> ingestion-bot -> Token  (or any user JWT),
//     then run:
//
//     window.OM_TOKEN='PASTE_JWT_HERE';window.OM_SF_SERVICE='your_service';fetch('https://raw.githubusercontent.com/ulixius9/code-samples/main/om_snowflake_lineage.js').then(r=>r.text()).then(eval)
//
// (d) Restrict to a single schema — pass its FQN (service.database.schema).
//     This queries the API directly for that schema instead of scanning
//     the whole service:
//
//     window.OM_SCHEMA_FQN='snowflake_prod.my_db.my_schema';fetch('https://raw.githubusercontent.com/ulixius9/code-samples/main/om_snowflake_lineage.js').then(r=>r.text()).then(eval)
//
//     Leave window.OM_SCHEMA_FQN unset (or '') to scan the whole service.
//
// After it finishes:
//   - Summary table is printed via console.table
//   - Full results: window.__sfLineage
//   - Copy as JSON:  copy(JSON.stringify(window.__sfLineage, null, 2))
// =============================================================================
//
// Usage:
//   1. Open OpenMetadata UI in browser, log in.
//   2. F12 -> Console.
//   3. Edit SERVICE_NAME below (or set window.OM_SF_SERVICE before fetching).
//   4. Paste one of the one-liners above & run.
//
// Result: window.__sfLineage = [{ table, upstream:[], downstream:[] }, ...]

(async () => {
  const SERVICE_NAME = window.OM_SF_SERVICE || 'snowflake_prod'; // <-- edit me
  const SAME_SERVICE_ONLY = false; // true = only edges within SERVICE_NAME; false = any Snowflake service
  // Restrict to a single schema by FQN (service.database.schema).
  // '' = scan every table in SERVICE_NAME.
  const SCHEMA_FQN =
    window.OM_SCHEMA_FQN !== undefined ? window.OM_SCHEMA_FQN : '';
  const PAGE_SIZE = 100;
  const base = `${location.origin}/api/v1`;

  // ---- Auth: OM UI uses JWT bearer tokens. Try a few common locations. ----
  const getToken = () => {
    if (window.OM_TOKEN) return window.OM_TOKEN; // manual override
    const cookieMatch = document.cookie.match(/(?:^|;\s*)oidcIdToken=([^;]+)/);
    if (cookieMatch) return decodeURIComponent(cookieMatch[1]);
    const keys = ['oidcIdToken', 'om-session', 'token', 'id_token', 'access_token'];
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v && v.split('.').length === 3) return v; // looks like JWT
    }
    // okta-style stash
    try {
      const okta = JSON.parse(localStorage.getItem('okta-token-storage') || '{}');
      if (okta?.idToken?.idToken) return okta.idToken.idToken;
      if (okta?.accessToken?.accessToken) return okta.accessToken.accessToken;
    } catch (_) {}
    return null;
  };

  const TOKEN = getToken();
  if (!TOKEN) {
    console.error(
      'No JWT found automatically. In the OM UI, copy your token from\n' +
      '  Settings -> Bots -> ingestion-bot -> Token  (or your user JWT),\n' +
      'then run:  window.OM_TOKEN = "PASTE_JWT_HERE"; \n' +
      'and re-run this script.'
    );
    return;
  }
  console.log('Using JWT (first 20 chars):', TOKEN.slice(0, 20) + '…');

  const j = (url) =>
    fetch(url, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    });

  // Cache service lookups so we can tell if a node is Snowflake
  const serviceTypeCache = new Map();
  const getServiceType = async (svcName) => {
    if (!svcName) return null;
    if (serviceTypeCache.has(svcName)) return serviceTypeCache.get(svcName);
    try {
      const svc = await j(
        `${base}/services/databaseServices/name/${encodeURIComponent(svcName)}`
      );
      serviceTypeCache.set(svcName, svc.serviceType);
      return svc.serviceType;
    } catch (e) {
      serviceTypeCache.set(svcName, null);
      return null;
    }
  };

  const isSnowflakeNode = async (node) => {
    const svcName =
      node?.service?.name ??
      (node?.fullyQualifiedName || '').split('.')[0];
    if (!svcName) return false;
    if (SAME_SERVICE_ONLY) return svcName === SERVICE_NAME;
    const t = await getServiceType(svcName);
    return t === 'Snowflake';
  };

  // 1. Page through tables — scoped to a schema if SCHEMA_FQN is set,
  //    otherwise the whole service.
  const tables = [];
  let after = '';
  const tablesQuery = SCHEMA_FQN
    ? `databaseSchema=${encodeURIComponent(SCHEMA_FQN)}`
    : `service=${encodeURIComponent(SERVICE_NAME)}`;
  while (true) {
    const url =
      `${base}/tables?${tablesQuery}` +
      `&limit=${PAGE_SIZE}&fields=service` +
      (after ? `&after=${encodeURIComponent(after)}` : '');
    const page = await j(url);
    tables.push(...page.data);
    after = page.paging?.after;
    if (!after) break;
  }
  console.log(`Found ${tables.length} tables in ${SCHEMA_FQN || SERVICE_NAME}`);

  // 2. Fetch lineage for each, keep only Snowflake-to-Snowflake edges
  const results = [];
  let i = 0;
  for (const t of tables) {
    i++;
    if (i % 25 === 0) console.log(`  …processed ${i}/${tables.length}`);
    try {
      const lin = await j(
        `${base}/lineage/table/name/${encodeURIComponent(
          t.fullyQualifiedName
        )}?upstreamDepth=1&downstreamDepth=1`
      );
      const nodesById = new Map((lin.nodes || []).map((n) => [n.id, n]));
      const ups = (lin.upstreamEdges || [])
        .map((e) => nodesById.get(e.fromEntity))
        .filter(Boolean);
      const downs = (lin.downstreamEdges || [])
        .map((e) => nodesById.get(e.toEntity))
        .filter(Boolean);
      const sfUps = [];
      for (const n of ups) if (await isSnowflakeNode(n)) sfUps.push(n);
      const sfDowns = [];
      for (const n of downs) if (await isSnowflakeNode(n)) sfDowns.push(n);
      if (sfUps.length || sfDowns.length) {
        results.push({
          table: t.fullyQualifiedName,
          upstream: sfUps.map((n) => n.fullyQualifiedName),
          downstream: sfDowns.map((n) => n.fullyQualifiedName),
        });
      }
    } catch (e) {
      console.warn('lineage failed for', t.fullyQualifiedName, e.message);
    }
  }

  console.log(`Tables with Snowflake↔Snowflake lineage: ${results.length}`);
  console.table(
    results.map((r) => ({
      table: r.table,
      upstream: r.upstream.length,
      downstream: r.downstream.length,
    }))
  );
  window.__sfLineage = results;
  console.log('Full results: window.__sfLineage');
  console.log('Copy as JSON:  copy(JSON.stringify(window.__sfLineage, null, 2))');
})();

