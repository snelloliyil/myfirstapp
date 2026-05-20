const express = require('express');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const app = express();
const PORT = 5081;
const ADO_ORG = 'dcteng';
const ADO_PROJECT = 'Duck Creek';

app.use(express.json());

// Get ADO auth token via az CLI or PAT env var
function getADOToken() {
  try {
    const result = execSync(
      'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv',
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    if (result) return { type: 'Bearer', token: result };
  } catch (_) {}
  const pat = process.env.AZURE_DEVOPS_PAT;
  if (pat) return { type: 'Basic', token: Buffer.from(`:${pat}`).toString('base64') };
  return null;
}

function adoGet(url) {
  return new Promise((resolve, reject) => {
    const auth = getADOToken();
    if (!auth) return reject(new Error('No ADO credentials found. Run `az login` or set AZURE_DEVOPS_PAT env var.'));
    https.get(url, { headers: { Authorization: `${auth.type} ${auth.token}`, 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(new Error('Failed to parse ADO response')); } });
    }).on('error', reject);
  });
}

function adoPost(url, body) {
  return new Promise((resolve, reject) => {
    const auth = getADOToken();
    if (!auth) return reject(new Error('No ADO credentials found. Run `az login` or set AZURE_DEVOPS_PAT env var.'));
    const data = JSON.stringify(body);
    const u = new URL(url);
    const options = {
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { Authorization: `${auth.type} ${auth.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { reject(new Error('Failed to parse ADO response')); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Serve static files
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'readme.html')));

// API: Get single work item by ID
app.get('/api/ticket/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid ticket ID' });
  try {
    const url = `https://dev.azure.com/${encodeURIComponent(ADO_ORG)}/_apis/wit/workitems/${id}?$expand=all&api-version=7.1`;
    const { status, body } = await adoGet(url);
    if (status === 404) return res.status(404).json({ error: `Ticket #${id} not found` });
    if (status === 401 || status === 203) return res.status(401).json({ error: 'ADO authentication failed. Run `az login`.' });
    if (status !== 200) return res.status(status).json({ error: body.message || 'ADO request failed' });
    const f = body.fields;
    const assignedTo = f['System.AssignedTo'];
    res.json({
      id: body.id,
      url: `https://dev.azure.com/${ADO_ORG}/${encodeURIComponent(ADO_PROJECT)}/_workitems/edit/${body.id}`,
      title: f['System.Title'],
      type: f['System.WorkItemType'],
      state: f['System.State'],
      reason: f['System.Reason'],
      priority: f['Microsoft.VSTS.Common.Priority'],
      severity: f['Microsoft.VSTS.Common.Severity'],
      areaPath: f['System.AreaPath'],
      iterationPath: f['System.IterationPath'],
      tags: f['System.Tags'],
      createdDate: f['System.CreatedDate'],
      changedDate: f['System.ChangedDate'],
      createdBy: f['System.CreatedBy']?.displayName || f['System.CreatedBy'],
      assignedTo: assignedTo ? { name: assignedTo.displayName, email: assignedTo.uniqueName } : null,
      description: f['System.Description'] || f['Microsoft.VSTS.TCM.ReproSteps'] || null,
      commentCount: f['System.CommentCount'],
      customerHighPriority: f['Custom.CustomerHighPriority'],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Search work items by keyword
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query param ?q=' });
  try {
    const org = encodeURIComponent(ADO_ORG);
    const project = encodeURIComponent(ADO_PROJECT);
    const wiql = { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${ADO_PROJECT}' AND [System.Title] CONTAINS '${q.replace(/'/g, "''")}' ORDER BY [System.ChangedDate] DESC` };
    const url = `https://dev.azure.com/${org}/${project}/_apis/wit/wiql?$top=10&api-version=7.1`;
    const result = await adoPost(url, wiql);
    if (result.status !== 200) return res.status(result.status).json({ error: result.body.message || 'Search failed' });
    res.json({ items: result.body.workItems || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: List tickets with filters (area path, severity, priority, state)
app.get('/api/tickets', async (req, res) => {
  try {
    const org = encodeURIComponent(ADO_ORG);
    const project = encodeURIComponent(ADO_PROJECT);

    // Parse filters
    const areaPaths = [].concat(req.query['areaPath[]'] || req.query.areaPath || [ADO_PROJECT]);
    const severities = [].concat(req.query['severity[]'] || req.query.severity || []);
    const priorities = [].concat(req.query['priority[]'] || req.query.priority || []);
    const states = [].concat(req.query['state[]'] || req.query.state || []);

    // Build WIQL conditions
    const areaCondition = areaPaths.length === 1
      ? `[System.AreaPath] UNDER '${areaPaths[0].replace(/'/g, "''")}'`
      : '(' + areaPaths.map(p => `[System.AreaPath] UNDER '${p.replace(/'/g, "''")}'`).join(' OR ') + ')';

    const conditions = [
      `[System.TeamProject] = '${ADO_PROJECT}'`,
      areaCondition,
    ];

    if (severities.length) {
      const vals = severities.map(s => `'${s.replace(/'/g, "''")}'`).join(',');
      conditions.push(`[Microsoft.VSTS.Common.Severity] IN (${vals})`);
    }
    if (priorities.length) {
      conditions.push(`[Microsoft.VSTS.Common.Priority] IN (${priorities.map(Number).join(',')})`);
    }
    if (states.length) {
      const vals = states.map(s => `'${s.replace(/'/g, "''")}'`).join(',');
      conditions.push(`[System.State] IN (${vals})`);
    }

    const dateMode = req.query.dateMode;
    const dateFrom = req.query.dateFrom;
    const dateTo   = req.query.dateTo;
    if (dateMode && dateFrom) {
      const from = new Date(dateFrom).toISOString().slice(0, 10);
      if (dateMode === 'gt') {
        conditions.push(`[System.CreatedDate] >= '${from}'`);
      } else if (dateMode === 'lt') {
        conditions.push(`[System.CreatedDate] <= '${from}'`);
      } else if (dateMode === 'between' && dateTo) {
        const to = new Date(dateTo).toISOString().slice(0, 10);
        conditions.push(`[System.CreatedDate] >= '${from}'`);
        conditions.push(`[System.CreatedDate] <= '${to}'`);
      }
    }

    const wiql = { query: `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(' AND ')} ORDER BY [System.ChangedDate] DESC` };
    const wiqlUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/wiql?$top=200&api-version=7.1`;
    const wiqlResult = await adoPost(wiqlUrl, wiql);

    if (wiqlResult.status !== 200) return res.status(wiqlResult.status).json({ error: wiqlResult.body.message || 'WIQL query failed' });

    const workItems = wiqlResult.body.workItems || [];
    if (workItems.length === 0) return res.json({ items: [], total: 0 });

    // Batch fetch work item details (max 200)
    const ids = workItems.slice(0, 200).map(w => w.id);
    const batchUrl = `https://dev.azure.com/${org}/_apis/wit/workitemsbatch?api-version=7.1`;
    const batchResult = await adoPost(batchUrl, {
      ids,
      fields: [
        'System.Id', 'System.Title', 'System.CreatedDate', 'System.ChangedDate',
        'System.AssignedTo', 'System.AreaPath', 'System.WorkItemType', 'System.State',
        'Custom.CustomerHighPriority', 'Microsoft.VSTS.Common.Severity', 'Microsoft.VSTS.Common.Priority',
      ],
    });

    if (batchResult.status !== 200) return res.status(batchResult.status).json({ error: batchResult.body.message || 'Batch fetch failed' });

    const items = batchResult.body.value.map(item => {
      const f = item.fields;
      const at = f['System.AssignedTo'];
      return {
        id: f['System.Id'],
        title: f['System.Title'],
        createdDate: f['System.CreatedDate'],
        changedDate: f['System.ChangedDate'],
        assignedTo: at ? { name: at.displayName, email: at.uniqueName } : null,
        areaPath: f['System.AreaPath'],
        type: f['System.WorkItemType'],
        state: f['System.State'],
        customerHighPriority: f['Custom.CustomerHighPriority'],
        severity: f['Microsoft.VSTS.Common.Severity'],
        priority: f['Microsoft.VSTS.Common.Priority'],
      };
    });

    res.json({ items, total: wiqlResult.body.workItems.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Webapp server running at http://localhost:${PORT}`));
