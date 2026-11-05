import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import intercom from "./index.ts";
import { getTsxLoaderPath } from "./broker/spawn.ts";

function harness(id: string, name: string) {
  const bus = new EventEmitter();
  const hooks = new Map<string, Function[]>();
  const tools: any[] = [];
  const incoming: any[] = [];
  const pi = {
    getSessionName: () => name,
    events: { on: (key: string, fn: any) => {bus.on(key,fn);return ()=>bus.off(key,fn);}, emit: (key: string, value: any) => bus.emit(key,value) },
    on: (key: string, fn: Function) => hooks.set(key,[...(hooks.get(key) ?? []),fn]),
    registerTool: (tool: any) => tools.push(tool),
    registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
    getActiveTools: () => tools.map(tool=>tool.name), setActiveTools() {},
    sendMessage: (message: any) => incoming.push(message), sendUserMessage() {},
  };
  const ctx = { cwd: process.cwd(), model:{id:"test-model"}, sessionManager:{getSessionId:()=>id}, isIdle:()=>true, hasUI:true };
  intercom(pi as never,"1.5.0");
  return { incoming, tools, async emit(event: string) {for(const fn of hooks.get(event) ?? []) await fn({},ctx);}, async call(params: any) {return tools.find(tool=>tool.name === "intercom").execute("test",params,undefined,undefined,ctx);} };
}

async function until(check:()=>boolean) {
  const deadline=Date.now()+3000;
  while(!check()) {
    if(Date.now()>deadline) throw new Error("Timed out waiting for injected message");
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}

test("extension discovery, alias send and origin-pinned reply round trip through two local brokers and a simulated SSH executable", {timeout:20000}, async () => {
  const root=mkdtempSync(join(tmpdir(),"piic-roundtrip-"));
  const dirs=[join(root,"a"),join(root,"b")];
  const bin=join(root,"bin");
  mkdirSync(bin,{recursive:true});
  const cli=resolve("cli.mjs");
  const remoteCommand=`${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}`;
  const previous={...process.env};
  const brokers: ReturnType<typeof spawn>[]=[];
  const sessions: ReturnType<typeof harness>[]=[];
  try {
    // These executables run only local child processes. No network SSH connection is made.
    writeFileSync(join(bin,"herdr"),"#!/bin/sh\nprintf '[]'\n",{mode:0o700});
    writeFileSync(join(bin,"ssh"),`#!${process.execPath}
const {spawn}=require('node:child_process');
const args=process.argv.slice(2); while(args[0]==='-o') args.splice(0,2);
const [host,command]=args; const dirs=${JSON.stringify({"local-a":dirs[0],"local-b":dirs[1]})};
if(!dirs[host]) process.exit(99);
const child=spawn('/bin/sh',['-c',command],{env:{...process.env,PI_CODING_AGENT_DIR:dirs[host],PI_INTERCOM_SCOPE_ID:''},stdio:'inherit'});
child.on('exit',code=>process.exit(code ?? 1));
`,{mode:0o700});
    process.env.PATH=bin+":"+process.env.PATH;
    process.env.HERDR_BIN_PATH=join(bin,"herdr");
    delete process.env.PI_INTERCOM_SCOPE_ID;
    delete process.env.HERDR_PANE_ID;
    delete process.env.PI_INTERCOM_SESSION_ID;
    delete process.env.PI_SESSION_ID;
    for(const [i,dir] of dirs.entries()) {
      mkdirSync(join(dir,"intercom"),{recursive:true});
      writeFileSync(join(dir,"intercom/config.json"),JSON.stringify({crossMachine:{machineName:i===0?"wsl":"macbook",remoteCommand,machines:{wsl:{target:"local-a"},macbook:{target:"local-b"}}}}));
      const broker=spawn(process.execPath,["--import",getTsxLoaderPath(),resolve("broker/broker.ts")],{env:{...process.env,PI_CODING_AGENT_DIR:dir},stdio:["ignore","pipe","pipe"]});
      brokers.push(broker);
      await new Promise<void>((res,rej)=>{
        const timer=setTimeout(()=>rej(new Error("broker startup timed out")),3000);
        broker.stdout!.on("data",chunk=>{if(String(chunk).includes("Intercom broker started")){clearTimeout(timer);res();}});
        broker.once("error",error=>{clearTimeout(timer);rej(error);});
        broker.once("exit",code=>{clearTimeout(timer);rej(new Error(`broker exited ${code}`));});
      });
      process.env.PI_CODING_AGENT_DIR=dir;
      const session=harness(i===0?"custom-source-broker-id":"custom-destination-broker-id",i===0?"spark-tests":"subagent-chat-arm-worker");
      sessions.push(session);
      await session.emit("session_start");
    }
    const [a,b]=sessions;
    const roster=await a!.call({action:"list-remote",machine:"macbook"});
    assert.notEqual(roster.details?.error,true,JSON.stringify(roster));
    assert.match(roster.content[0].text,/subagent-chat-arm-worker@macbook/);
    assert.doesNotMatch(roster.content[0].text,/pi-intercom-cli/);
    const sent=await a!.call({action:"send",to:"subagent-chat-arm-worker@macbook",message:"Please collect ARM details asynchronously."});
    assert.equal(sent.details?.delivered,true,JSON.stringify(sent));
    await until(()=>b!.incoming.length===1);
    assert.match(b!.incoming[0].content,/unverified cross-machine/);
    assert.match(b!.incoming[0].content,/action: "reply"/);
    await b!.emit("turn_start");
    const reply=await b!.call({action:"reply",message:"ARM details are ready."});
    assert.equal(reply.details?.delivered,true,JSON.stringify(reply));
    await until(()=>a!.incoming.length===1);
    assert.match(a!.incoming[0].content,/ARM details are ready/);
    assert.match(a!.incoming[0].content,/subagent-chat-arm-worker@macbook/);
    // Success required the actual custom broker IDs, which do not come from any Herdr session path.
    assert.match(a!.incoming[0].content,/unverified cross-machine/);
    const missing=await a!.call({action:"send",to:"llaminar@macbook",message:"must fail with candidates"});
    assert.equal(missing.details?.error,true);
    assert.match(missing.content[0].text,/Candidates:.*subagent-chat-arm-worker@macbook/);
    assert.equal(b!.incoming.length,1);
  } finally {
    for(const [i,session] of sessions.entries()) {
      process.env.PI_CODING_AGENT_DIR=dirs[i];
      await session.emit("session_shutdown");
    }
    for(const broker of brokers) if(broker.exitCode===null && broker.signalCode===null){const exited=once(broker,"exit");broker.kill("SIGTERM");await exited;}
    for(const key of Object.keys(process.env)) if(!(key in previous)) delete process.env[key];
    Object.assign(process.env,previous);
    rmSync(root,{recursive:true,force:true});
  }
});
