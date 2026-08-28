import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { startEngineBrokerMcpFacade } from "./engineBrokerMcpFacade.js";

test("MCP facade routes only valid active capabilities to the registered mount", async () => {
  let calls=0;const target=createServer((_request,response)=>{calls++;response.writeHead(200,{"content-type":"application/json"});response.end('{"ok":true}');});await new Promise<void>((resolve)=>target.listen(0,"127.0.0.1",resolve));const address=target.address();if(address===null||typeof address==="string")throw new Error();
  const facade=await startEngineBrokerMcpFacade();const token=facade.register("agent","turn",`http://127.0.0.1:${address.port}/mcp`);const call=(value:string)=>fetch("http://127.0.0.1:43124/mcp",{method:"POST",headers:{authorization:`Bearer ${value}`,"content-type":"application/json"},body:"{}"});
  try{assert.equal((await call("wrong-token-abcdefghijklmnopqrstuvwxyz0123456789")).status,403);assert.equal((await call(token)).status,200);assert.equal(calls,1);facade.revoke("turn");assert.equal((await call(token)).status,403);assert.equal(calls,1);}finally{await facade.close();await new Promise<void>((resolve)=>target.close(()=>resolve()));}
});
