import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

function scriptHarness() {
  const properties:Record<string,string>={RAFINAD_URL:'https://roadmap.example',INTEGRATION_ID:'mail',INTEGRATION_SECRET:'a'.repeat(40),MAILBOX_ID:'test-mailbox',ALLOWED_SENDER:'robot@example.com'};
  const messages=new Map<string,Set<string>>([['m1',new Set()]]);
  const posted:any[]=[];let released=false;let failLabel=false;
  let responder:(url:string,body:any)=>{code:number;body?:unknown}=(url,b)=>({code:200,body:url.endsWith('/events')?{accepted:true,event_id:'evt-'+b.delivery_id}:{ok:true}});
  const sandbox:any={
    PropertiesService:{getScriptProperties:()=>({getProperty:(k:string)=>properties[k]??null,setProperty:(k:string,v:string)=>{properties[k]=v;}})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{released=true;}})},
    Utilities:{newBlob:(s:string)=>({getBytes:()=>Buffer.from(s)})},
    Gmail:{Users:{Labels:{list:()=>({labels:[{id:'done',name:'Rafinad/Delivered'},{id:'bad',name:'Rafinad/Error'}]})},Messages:{
      list:(_:string,opts:any)=>({messages:[...messages].filter(([,ls])=>opts.labelIds?ls.has('bad'):!ls.has('done')&&!ls.has('bad')).slice(0,opts.maxResults).map(([id])=>({id,threadId:'one-thread'}))}),
      modify:(body:any,_:string,id:string)=>{if(failLabel){failLabel=false;throw new Error('crash after ack');}for(const l of body.addLabelIds??[])messages.get(id)!.add(l);for(const l of body.removeLabelIds??[])messages.get(id)!.delete(l);}
    }}},
    GmailApp:{getMessageById:(id:string)=>({getFrom:()=> 'Robot <robot@example.com>',getSubject:()=>`RAFINAD_SYNC | BITRIX | CREATE | ${id}`,getPlainBody:()=>`message ${id}`,getDate:()=>new Date('2026-10-15T09:00:00Z')})},
    UrlFetchApp:{fetch:(url:string,opts:any)=>{const b=JSON.parse(opts.payload);posted.push({url,body:b,opts});const r=responder(url,b);return {getResponseCode:()=>r.code,getContentText:()=>JSON.stringify(r.body??{})};}},
  };
  runInNewContext(readFileSync(new URL('../integrations/gmail/Code.gs',import.meta.url),'utf8'),sandbox);
  return {sandbox,properties,messages,posted,released:()=>released,setResponder:(fn:typeof responder)=>{responder=fn;},failLabel:()=>{failLabel=true;}};
}
test('Gmail tracks each message, including a new message in an already delivered thread',()=>{
  const h=scriptHarness();h.sandbox.syncRafinadInbox();assert.ok(h.messages.get('m1')!.has('done'));
  h.messages.set('m2',new Set());h.sandbox.syncRafinadInbox();
  const events=h.posted.filter(p=>p.url.endsWith('/events'));assert.equal(events.length,2);assert.equal(events[1].body.delivery_id,'test-mailbox:m2');assert.equal(events[0].opts.followRedirects,false);assert.ok(h.released());
});
test('lost HTTP response does not mark delivered; retry uses same key and bounded backoff',()=>{
  const h=scriptHarness();let fail=true;h.setResponder((url,b)=>{if(url.endsWith('/events')&&fail){fail=false;throw new Error('lost response');}return {code:200,body:url.endsWith('/events')?{accepted:true,event_id:'same-event'}:{ok:true}};});
  h.sandbox.syncRafinadInbox();assert.equal(h.messages.get('m1')!.size,0);assert.equal(JSON.parse(h.properties.RF_RETRY_STATE).m1.count,1);
  h.sandbox.syncRafinadInbox();assert.equal(h.posted.filter(p=>p.url.endsWith('/events')).length,1,'not due yet');
  h.properties.RF_RETRY_STATE=JSON.stringify({m1:{count:1,next:0}});h.sandbox.syncRafinadInbox();
  const requests=h.posted.filter(p=>p.url.endsWith('/events'));assert.equal(requests[0].body.delivery_id,requests[1].body.delivery_id);assert.ok(h.messages.get('m1')!.has('done'));assert.equal(h.properties.RF_RETRY_STATE,'{}');
});
test('crash after durable acceptance but before label is safe to retry',()=>{
  const h=scriptHarness();h.failLabel();assert.throws(()=>h.sandbox.syncRafinadInbox());assert.ok(h.released());assert.equal(h.messages.get('m1')!.size,0);
  h.sandbox.syncRafinadInbox();const events=h.posted.filter(p=>p.url.endsWith('/events'));assert.equal(events.length,2);assert.equal(events[0].body.delivery_id,events[1].body.delivery_id);assert.ok(h.messages.get('m1')!.has('done'));
});
test('permanent HTTP errors enter message quarantine; manual replay removes only processing labels',()=>{
  const h=scriptHarness();h.messages.get('m1')!.add('inbox');h.setResponder(()=>({code:413}));h.sandbox.syncRafinadInbox();
  assert.ok(h.messages.get('m1')!.has('bad'));assert.ok(!h.messages.get('m1')!.has('done'));assert.match(h.properties.RF_DIAGNOSTICS,/delivery_413/);
  h.sandbox.retryRafinadErrors();assert.deepEqual([...h.messages.get('m1')!],['inbox']);
});
test('2xx without durable acknowledgement is not success, backend quarantine is visible',()=>{
  const h=scriptHarness();h.setResponder(()=>({code:200,body:{}}));h.sandbox.syncRafinadInbox();assert.equal(h.messages.get('m1')!.size,0);
  h.properties.RF_RETRY_STATE='{}';h.setResponder(()=>({code:202,body:{accepted:true,event_id:'evt',quarantined:true}}));h.sandbox.syncRafinadInbox();assert.ok(h.messages.get('m1')!.has('bad'));assert.ok(h.messages.get('m1')!.has('done'));
});
test('empty mailbox still sends a heartbeat and no corporate text enters diagnostics',()=>{
  const h=scriptHarness();h.messages.clear();h.sandbox.syncRafinadInbox();assert.equal(h.posted.length,1);assert.ok(h.posted[0].url.endsWith('/heartbeat'));assert.equal(h.posted[0].body.found,0);
  assert.ok(!JSON.stringify(h.properties).includes('message m1'));
});

test('failed delivery is retried even when newer messages fill the scan window',()=>{
  const h=scriptHarness();h.messages.clear();
  for(let n=0;n<100;n++)h.messages.set('new-'+n,new Set());
  h.messages.set('old',new Set());h.properties.RF_RETRY_STATE=JSON.stringify({old:{count:1,next:0}});
  h.sandbox.syncRafinadInbox();
  assert.equal(h.posted[0].body.delivery_id,'test-mailbox:old');assert.ok(h.messages.get('old')!.has('done'));
});

test('unavailable message releases its retry slot without deleting other mail',()=>{
  const h=scriptHarness();h.properties.RF_RETRY_STATE=JSON.stringify({gone:{count:1,next:0}});
  const original=h.sandbox.GmailApp.getMessageById;
  h.sandbox.GmailApp.getMessageById=(id:string)=>id==='gone'?null:original(id);
  h.sandbox.syncRafinadInbox();assert.equal(h.properties.RF_RETRY_STATE,'{}');
  assert.match(h.properties.RF_DIAGNOSTICS,/message_unavailable/);assert.ok(h.messages.get('m1')!.has('done'));
});
