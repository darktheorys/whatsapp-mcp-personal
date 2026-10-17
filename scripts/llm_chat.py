#!/usr/bin/env python3
"""A small local chat page for a model you have downloaded, no terminal needed after it starts.

    python3 scripts/llm_chat.py                                   default model, opens the browser
    python3 scripts/llm_chat.py --model mlx-community/gemma-4-12B-it-4bit
    python3 scripts/llm_chat.py --port 9000 --no-open

It loads the model in this process and serves one page at http://127.0.0.1:8765. Everything stays on this
machine: the page loads nothing from the internet (no fonts, no scripts, no analytics), the server listens
on 127.0.0.1 only, and the model is loaded offline from the Hugging Face cache. It deliberately does not
use mlx-lm's own HTTP server: that one answers any website that asks (a wildcard CORS header), so a page
open in another browser tab could use the model. This server only answers requests whose Host and Origin
are its own address, and accepts only the fields a chat needs (messages, temperature, max tokens, thinking
on or off).

Needs state/llm-venv with mlx-lm (python3.12 -m venv state/llm-venv && state/llm-venv/bin/pip install mlx-lm)
and the model in the Hugging Face cache (python3 scripts/install_model.py <repo>). It re-runs itself inside that
environment. Ctrl+C stops it.
"""

import argparse
import http.server
import json
import os
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
VENV_PY = REPO / "state" / "llm-venv" / "bin" / "python"
DEFAULT_MODEL = "mlx-community/gemma-4-e4b-it-4bit"
MAX_BODY = 1_000_000

PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local chat</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e4e3de;--me:#e9efe7;--acc:#2f6f4f}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--mut:#9a9992;--card:#1f1f1c;--line:#34332f;--me:#26332b;--acc:#7fc29b}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;flex-direction:column}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
header h1{font-size:15px;margin:0;font-weight:600}
header .grow{flex:1}
label{font-size:13px;color:var(--mut);display:flex;align-items:center;gap:6px}
button,select,textarea,input{font:inherit;color:inherit}
button{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
button:disabled{opacity:.5;cursor:default}
#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:min(760px,100%);padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:var(--card);white-space:pre-wrap;word-wrap:break-word}
.msg.user{align-self:flex-end;background:var(--me)}
.msg .who{font-size:12px;color:var(--mut);margin-bottom:2px}
#bar{border-top:1px solid var(--line);padding:12px 16px;display:flex;flex-direction:column;gap:8px}
#row{display:flex;gap:8px;align-items:flex-end}
#input{flex:1;resize:none;min-height:44px;max-height:200px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--card)}
#opts{display:none;gap:16px;flex-wrap:wrap;align-items:center}
#opts.show{display:flex}
#sys{width:100%;min-height:54px;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--card)}
#stat{font-size:12px;color:var(--mut)}
@media (max-width:600px){header{padding:8px 12px}#log{padding:12px}#bar{padding:10px 12px}}
</style></head>
<body>
<header>
  <h1>Local chat</h1><span id="model" class="grow" style="color:var(--mut);font-size:13px"></span>
  <button id="toggle">Settings</button><button id="clear">New chat</button>
</header>
<div id="log"></div>
<div id="bar">
  <div id="opts">
    <textarea id="sys" placeholder="System prompt (optional)"></textarea>
    <label>Temperature <input id="temp" type="range" min="0" max="1.5" step="0.1" value="0.7"><span id="tv">0.7</span></label>
    <label>Max tokens <input id="max" type="number" min="16" max="4096" value="512" style="width:80px"></label>
    <label><input id="think" type="checkbox"> Thinking (slower)</label>
  </div>
  <div id="row">
    <textarea id="input" rows="1" placeholder="Message. Enter sends, Shift+Enter adds a line."></textarea>
    <button id="send" class="primary">Send</button><button id="stop" disabled>Stop</button>
  </div>
  <div id="stat"></div>
</div>
<script>
const $=id=>document.getElementById(id);
let history=[],ctrl=null;
try{history=JSON.parse(localStorage.getItem("chat")||"[]")}catch(e){}
function save(){try{localStorage.setItem("chat",JSON.stringify(history))}catch(e){}}
function bubble(role,text){const d=document.createElement("div");d.className="msg "+role;
  const w=document.createElement("div");w.className="who";w.textContent=role==="user"?"You":"Model";
  const b=document.createElement("div");b.textContent=text;d.append(w,b);$("log").append(d);$("log").scrollTop=1e9;return b}
function render(){$("log").textContent="";history.forEach(m=>bubble(m.role,m.content))}
fetch("/api/info").then(r=>r.json()).then(i=>{$("model").textContent=i.model}).catch(()=>{});
$("toggle").onclick=()=>$("opts").classList.toggle("show");
$("temp").oninput=()=>{$("tv").textContent=$("temp").value};
$("clear").onclick=()=>{if(ctrl)ctrl.abort();history=[];save();render();$("stat").textContent=""};
$("input").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}});
$("input").addEventListener("input",()=>{const t=$("input");t.style.height="auto";t.style.height=Math.min(200,t.scrollHeight)+"px"});
$("send").onclick=send;$("stop").onclick=()=>{if(ctrl)ctrl.abort()};
async function send(){
  const text=$("input").value.trim();if(!text||ctrl)return;
  $("input").value="";$("input").style.height="auto";
  history.push({role:"user",content:text});bubble("user",text);
  const out=bubble("assistant","");let acc="",n=0,t0=null;
  const msgs=[];const sys=$("sys").value.trim();if(sys)msgs.push({role:"system",content:sys});
  history.forEach(m=>msgs.push(m));
  ctrl=new AbortController();$("send").disabled=true;$("stop").disabled=false;$("stat").textContent="loading...";
  try{
    const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},signal:ctrl.signal,
      body:JSON.stringify({messages:msgs,temperature:+$("temp").value,max_tokens:+$("max").value,thinking:$("think").checked})});
    if(!r.ok)throw new Error("server said "+r.status);
    const rd=r.body.getReader(),dec=new TextDecoder();let buf="";
    for(;;){const {value,done}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});
      let i;while((i=buf.indexOf("\n"))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
        if(!line.startsWith("data:"))continue;const d=line.slice(5).trim();if(d==="[DONE]")continue;
        try{const c=JSON.parse(d).choices?.[0]?.delta?.content;if(c){if(!t0)t0=performance.now();acc+=c;n++;out.textContent=acc;$("log").scrollTop=1e9;
          $("stat").textContent=n+" chunks, "+(n/((performance.now()-t0)/1000||1)).toFixed(1)+" per second"}}catch(e){}}}
  }catch(e){if(e.name!=="AbortError"){out.textContent=(acc?acc+"\n\n":"")+"[error: "+e.message+"]"}}
  finally{ctrl=null;$("send").disabled=false;$("stop").disabled=true;if(acc){history.push({role:"assistant",content:acc});save()}
    else if(history.at(-1)?.role==="user"){history.pop()}}
}
render();
</script></body></html>
"""


class Chat(http.server.BaseHTTPRequestHandler):
    model_name = ""
    model: Any = None
    tokenizer: Any = None
    own_hosts = set()
    # One request at a time on purpose: MLX keeps its GPU stream per thread, so the model has to be used
    # from the thread that loaded it, which a threaded server would not do.

    def log_message(self, format, *args):
        pass

    def _own(self):
        """Only this page may use the server: its own Host, and an Origin that is itself or absent."""
        if self.headers.get("Host") not in self.own_hosts:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {f"http://{h}" for h in self.own_hosts}

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._own():
            return self._send(403, '{"error":"forbidden"}')
        if self.path == "/":
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if self.path == "/favicon.ico":
            return self._send(204, b"", "image/x-icon")
        if self.path == "/api/info":
            return self._send(200, json.dumps({"model": self.model_name}))
        self._send(404, '{"error":"not found"}')

    def do_POST(self):
        if not self._own() or self.path != "/api/chat":
            return self._send(403, '{"error":"forbidden"}')
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                return self._send(413, '{"error":"too large"}')
            req = json.loads(self.rfile.read(length))
            messages = [
                {"role": m["role"], "content": str(m["content"])}
                for m in req["messages"]
                if m.get("role") in ("system", "user", "assistant")
            ]
            if not messages:
                return self._send(400, '{"error":"no messages"}')
            temperature = min(1.5, max(0.0, float(req.get("temperature", 0.7))))
            max_tokens = min(4096, max(16, int(req.get("max_tokens", 512))))
            thinking = bool(req.get("thinking"))
        except (ValueError, KeyError, TypeError):
            return self._send(400, '{"error":"bad request"}')
        try:
            from mlx_lm import stream_generate  # pyright: ignore[reportMissingImports]
            from mlx_lm.sample_utils import make_sampler  # pyright: ignore[reportMissingImports]

            ids = self.tokenizer.apply_chat_template(
                messages,
                add_generation_prompt=True,
                enable_thinking=thinking,
                return_dict=False,
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            for piece in stream_generate(
                self.model,
                self.tokenizer,
                prompt=ids,
                max_tokens=max_tokens,
                sampler=make_sampler(temp=temperature),
            ):
                event = {"choices": [{"delta": {"content": piece.text}}]}
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return  # the Stop button closes the connection, which ends the generation


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-open", action="store_true", help="do not open the browser")
    a = p.parse_args()
    if not VENV_PY.exists():
        sys.exit(
            "state/llm-venv is missing. Create it first:\n"
            "  python3.12 -m venv state/llm-venv && state/llm-venv/bin/pip install mlx-lm"
        )
    if Path(sys.prefix).resolve() != (REPO / "state" / "llm-venv").resolve():
        os.execv(str(VENV_PY), [str(VENV_PY), *sys.argv])
    os.environ["HF_HUB_OFFLINE"] = "1"
    from mlx_lm import load  # pyright: ignore[reportMissingImports]

    print(f"Loading {a.model} ...", flush=True)
    model, tokenizer = load(a.model)
    Chat.model_name, Chat.model, Chat.tokenizer = a.model, model, tokenizer
    Chat.own_hosts = {f"127.0.0.1:{a.port}", f"localhost:{a.port}"}
    httpd = http.server.HTTPServer(("127.0.0.1", a.port), Chat)
    url = f"http://127.0.0.1:{a.port}"
    print(f"Ready: {url}   (Ctrl+C to stop)", flush=True)
    if not a.no_open:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
