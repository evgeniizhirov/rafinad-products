/** Rafinad Inbox — install in the destination Gmail account. Enable the Advanced Gmail service.
 * No secrets or corporate content are logged. Each Gmail message has its own delivery state.
 * Script Properties: RAFINAD_URL, INTEGRATION_ID, INTEGRATION_SECRET, MAILBOX_ID, ALLOWED_SENDER.
 */
var RF_MAX_SEND = 25;
var RF_MAX_SCAN = 100;
var RF_MAX_BYTES = 500000;

function rfConfig() {
  var p = PropertiesService.getScriptProperties();
  var url = (p.getProperty('RAFINAD_URL') || '').replace(/\/$/, '');
  if (!/^https:\/\/[^/?#]+$/.test(url)) throw new Error('RAFINAD_URL must be an HTTPS origin');
  var cfg = { url: url, id: p.getProperty('INTEGRATION_ID'), secret: p.getProperty('INTEGRATION_SECRET'), mailbox: p.getProperty('MAILBOX_ID'), sender: p.getProperty('ALLOWED_SENDER') };
  if (!cfg.id || !cfg.secret || cfg.secret.length < 32 || cfg.secret.length > 256 || !cfg.mailbox || cfg.mailbox.length > 200 || !cfg.sender) throw new Error('Missing or invalid integration settings');
  return cfg;
}

function rfLabels() {
  var labels = Gmail.Users.Labels.list('me').labels || [];
  function id(name) {
    var match = labels.filter(function(l) { return l.name === name; })[0];
    return match ? match.id : Gmail.Users.Labels.create({ name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, 'me').id;
  }
  return { delivered: id('Rafinad/Delivered'), error: id('Rafinad/Error') };
}

function rfPost(cfg, path, body) {
  var text = JSON.stringify(body);
  if (Utilities.newBlob(text).getBytes().length > RF_MAX_BYTES) return { code: 413 };
  var response = UrlFetchApp.fetch(cfg.url + '/api/integrations/' + path, {
    method: 'post', contentType: 'application/json', payload: text, followRedirects: false, muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + cfg.secret, 'X-Integration-Id': cfg.id }
  });
  var result = { code: response.getResponseCode() };
  try { result.body = JSON.parse(response.getContentText()); } catch (_) { /* not an acknowledgement */ }
  return result;
}

function rfDiagnostic(properties, messageId, code) {
  var records = JSON.parse(properties.getProperty('RF_DIAGNOSTICS') || '[]');
  records.push({ message_id: messageId, code: code, at: new Date().toISOString() });
  properties.setProperty('RF_DIAGNOSTICS', JSON.stringify(records.slice(-30)));
}

function syncRafinadInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var cfg = rfConfig(), labels = rfLabels(), properties = PropertiesService.getScriptProperties();
    var retry = JSON.parse(properties.getProperty('RF_RETRY_STATE') || '{}');
    var started = Date.now(), sent = 0, errors = 0, attempts = 0, found = 0, oldest = null;
    // Do not exclude whole threads: message-level Gmail API labels are authoritative.
    // Collect IDs before changing labels, so pagination cannot skip mutated results.
    var ids = [], page;
    do {
      var batch = Gmail.Users.Messages.list('me', { q: 'subject:RAFINAD_SYNC -label:Rafinad/Delivered -label:Rafinad/Error', maxResults: Math.min(50, RF_MAX_SCAN - ids.length), pageToken: page });
      ids = ids.concat((batch.messages || []).map(function(m) { return m.id; }));
      page = batch.nextPageToken;
    } while (page && ids.length < RF_MAX_SCAN);
    found = ids.length;
    // New mail must not push previously failed deliveries outside the scanned page forever.
    ids = Object.keys(retry).concat(ids).filter(function(id, index, all) { return all.indexOf(id) === index; });
    for (var n = 0; n < ids.length && attempts < RF_MAX_SEND && Date.now() - started < 240000; n++) {
      var id = ids[n];
      if (retry[id] && retry[id].next > Date.now()) continue;
      // Bound the retry ledger below Script Properties limits. Existing queued IDs take precedence.
      if (!retry[id] && Object.keys(retry).length >= 60) continue;
      attempts++;
      var response;
      try {
        var m = GmailApp.getMessageById(id);
        if (!m) {
          rfDiagnostic(properties, id, 'message_unavailable'); delete retry[id];
          properties.setProperty('RF_RETRY_STATE', JSON.stringify(retry)); errors++; continue;
        }
        var from = m.getFrom(), sender = (/<([^<>]+)>/.exec(from) || [null, from])[1].trim().toLowerCase();
        var date = m.getDate().toISOString(); if (!oldest || date < oldest) oldest = date;
        if (sender !== cfg.sender.toLowerCase()) {
          response = { code: 422 };
        } else {
          response = rfPost(cfg, 'events', { delivery_id: cfg.mailbox + ':' + id,
            event: { subject: m.getSubject(), from: from, text: m.getPlainBody() } });
        }
      } catch (_) { response = { code: 0 }; }
      if (response.code >= 200 && response.code < 300 && response.body && response.body.accepted === true && response.body.event_id) {
        // Crash before this mark causes an idempotent resend, never a lost message.
        Gmail.Users.Messages.modify({ addLabelIds: response.body.quarantined ? [labels.delivered, labels.error] : [labels.delivered] }, 'me', id);
        delete retry[id]; sent++; if (response.body.quarantined) errors++;
      } else {
        errors++;
        var permanent = response.code >= 400 && response.code < 500 && [401, 403, 408, 429].indexOf(response.code) < 0;
        var count = (retry[id] ? retry[id].count : 0) + 1;
        if (permanent || count >= 8) {
          Gmail.Users.Messages.modify({ addLabelIds: [labels.error] }, 'me', id);
          rfDiagnostic(properties, id, 'delivery_' + response.code); delete retry[id];
        } else retry[id] = { count: count, next: Date.now() + Math.min(3600000, 300000 * Math.pow(2, count - 1)) };
        if ([0, 401, 403, 429, 503].indexOf(response.code) >= 0) break;
      }
      properties.setProperty('RF_RETRY_STATE', JSON.stringify(retry));
    }
    properties.setProperty('RF_RETRY_STATE', JSON.stringify(retry));
    try {
      var heartbeat = rfPost(cfg, 'heartbeat', { found: found, sent: sent, errors: errors, oldest_pending_at: errors ? oldest : null });
      if (heartbeat.code < 200 || heartbeat.code >= 300) rfDiagnostic(properties, null, 'heartbeat_' + heartbeat.code);
    } catch (_) { rfDiagnostic(properties, null, 'heartbeat_transport'); }
  } finally { lock.releaseLock(); }
}

function installRafinadTrigger() {
  rfConfig();
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === 'syncRafinadInbox') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncRafinadInbox').timeBased().everyMinutes(5).create();
}

/** Manual retry after fixing configuration/parser. Gmail originals are never deleted. */
function retryRafinadErrors() {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return;
  try {
    var labels = rfLabels();
    var messages = Gmail.Users.Messages.list('me', { labelIds: [labels.error], maxResults: 50 }).messages || [];
    messages.forEach(function(m) { Gmail.Users.Messages.modify({ removeLabelIds: [labels.error, labels.delivered] }, 'me', m.id); });
  } finally { lock.releaseLock(); }
}
