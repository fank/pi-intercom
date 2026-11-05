import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { crossMachineReplyTarget } from "./cross-machine-envelope.ts";
import { discoverRemoteAgent } from "./cross-machine-discovery.ts";
import { runCli, parseCliArgs, type CliClient } from "./cli.ts";
import type { Message, SessionInfo } from "./types.ts";

const origin={name:"arm-worker",sessionId:"stable-source",machine:"macbook"};
const from: SessionInfo={id:"transient-relay-id",name:"arm-worker@macbook",model:"pi-intercom-cli",cwd:"/",pid:1,startedAt:1,lastActivity:1};
const remote=(id="message-1",sessionId="stable-source"): Message=>({id,timestamp:1,content:{text:"hello"},crossMachine:{type:"ssh-relay",version:1,trust:"ssh-asserted",origin:{...origin,sessionId}}});

test("cross-host replies use asserted broker identity internally, not transient CLI identity",()=>{
  const tracker=new ReplyTracker(1000);
  const context=tracker.recordIncomingMessage(from,remote(),100);
  tracker.queueTurnContext(context);
  tracker.beginTurn(101);
  assert.equal(crossMachineReplyTarget(tracker.resolveReplyTarget({},102).message.crossMachine!.origin),"stable-source@macbook");
  tracker.endTurn();
  assert.equal(tracker.resolveReplyTarget({to:"arm-worker@macbook"},103).message.id,"message-1");
  tracker.markReplied("message-1");
  assert.throws(()=>tracker.resolveReplyTarget({to:"arm-worker@macbook"},104),/No pending ask/);
});

test("duplicate asserted aliases on different origin sessions stay ambiguous outside the active turn",()=>{
  const tracker=new ReplyTracker(1000);
  tracker.recordIncomingMessage(from,remote("one","source-one"),100);
  tracker.recordIncomingMessage({...from,id:"relay-two"},remote("two","source-two"),101);
  assert.throws(()=>tracker.resolveReplyTarget({to:"arm-worker@macbook"},102),/Multiple pending asks/);
  assert.equal(tracker.resolveReplyTarget({replyTo:"one"},102).message.crossMachine!.origin.sessionId,"source-one");
});

test("recent origin contexts expire and cannot turn into transient mailboxes",()=>{
  const tracker=new ReplyTracker(1000);
  tracker.recordIncomingMessage(from,remote(),100);
  assert.throws(()=>tracker.resolveReplyTarget({to:"arm-worker@macbook"},1101),/No pending ask/);
  assert.throws(()=>crossMachineReplyTarget({...origin,sessionId:"unknown"}),/no usable live-source/);
  assert.throws(()=>crossMachineReplyTarget({...origin,machine:"bad@machine"}),/no usable live-source/);
});

test("an origin-pinned stale ID never falls back to somebody else's matching alias",async()=>{
  const run=async(command: string)=>({code:0,stderr:"",stdout:JSON.stringify(command==="herdr" ? [{label:"macbook",target:"trusted",enabled:true}] : {ok:true,sessions:[{id:"replacement",name:"stable-source",model:"m"}]})});
  await assert.rejects(discoverRemoteAgent("stable-source@macbook",{run,herdrBin:"herdr",exactSessionId:true}),/No live broker peer/);
});

test("per-machine commands are validated and duplicate or option-like destinations are rejected",()=>{
  const root=mkdtempSync(join(tmpdir(),"piic-hostconfig-"));
  const old=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=root;
  mkdirSync(join(root,"intercom"));
  try {
    const configure=(machines:unknown)=>writeFileSync(join(root,"intercom/config.json"),JSON.stringify({crossMachine:{machines}}));
    configure({macbook:{target:"user@macbook",remoteCommand:"/opt/node /opt/intercom/cli.mjs"}});
    assert.equal(loadConfig().crossMachine.machines!.macbook!.target,"user@macbook");
    for(const invalid of [{macbook:{target:"-oProxyCommand=bad"}},{macbook:{target:"valid"},MACBOOK:{target:"other"}},{macbook:{remoteCommand:"node\ncommand"}},{macbook:{enabled:"false"}}]) {
      configure(invalid);
      assert.throws(()=>loadConfig());
    }
  } finally {
    if(old===undefined) delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;
    rmSync(root,{recursive:true,force:true});
  }
});

function client(): CliClient {
  return {sessionId:"cli-self",async connect(){},async listSessions(){return [{...from,id:"cli-self"},{...from,id:"peer",name:"worker",model:"m"}];},async send(){return {id:"sent",delivered:true};},on(){},async disconnect(){}};
}

test("CLI remote enumeration needs no local broker registration and preserves usable alias data",async()=>{
  const c=client();
  c.connect=async()=>{throw new Error("must not register for remote enumeration");};
  let output="";
  const code=await runCli(["list-remote","--machine","macbook","--json"],{client:c,out:{write:s=>{output+=s;}},listRemote:async(machine)=>({machine:{label:machine!,target:"trusted",enabled:true},agents:[{name:"arm-worker",sessionId:"stable-source",cwd:"/repo",status:"working"}]})});
  assert.equal(code,0);
  assert.equal(JSON.parse(output).agents[0].name,"arm-worker");
  assert.throws(()=>parseCliArgs(["send","--to","worker","--text","hello","--machine","macbook"]),/only valid for list-remote/);
});

test("CLI list excludes its own transient session",async()=>{
  let output="";
  assert.equal(await runCli(["list","--json"],{client:client(),out:{write:s=>{output+=s;}}}),0);
  assert.deepEqual(JSON.parse(output).sessions.map((row:any)=>row.id),["peer"]);
});

test("a plain SSH CLI send explicitly warns that it is not a two-way cross-host bridge",async()=>{
  const old=process.env.SSH_CONNECTION;
  process.env.SSH_CONNECTION="test fixture";
  try {
    let output="";
    assert.equal(await runCli(["send","--to","worker","--text","hello","--json"],{client:client(),out:{write:s=>{output+=s;}}}),0);
    assert.match(JSON.parse(output).warning,/destination-local mailbox/);
  } finally {if(old===undefined)delete process.env.SSH_CONNECTION;else process.env.SSH_CONNECTION=old;}
});
