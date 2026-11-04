#!/usr/bin/env python3
"""Narrow Hermes OAuth transport. No agent context, tools, private history or credential export.
Default/--doctor resolves metadata only. --smoke makes one fixed non-sensitive model turn.
--execute reads one {system,user} JSON request on stdin; integration owner serializes real tasks.
"""
from __future__ import annotations
import argparse,contextlib,datetime,hashlib,io,json,os,pathlib,sys,tempfile,signal


def transport(payload, *, execute=False, smoke=False, runtime=None):
    started=datetime.datetime.now(datetime.timezone.utc).isoformat()
    capture=io.StringIO()
    receipt={'started_at':started,'transport':'hermes_codex_app_server','model_turns':0,
             'credential_exported':False,'private_history_loaded':False,'fallback_used':False,
             'soul_loaded':False,'memory_loaded':False,'background_review':False,'tools_policy':'none',
             'guard_bypass':False,'state':'NOT_RUN'}
    try:
        with contextlib.redirect_stdout(capture),contextlib.redirect_stderr(capture):
            if runtime is None:
                from hermes_cli.runtime_provider import resolve_runtime_provider
                from hermes_cli.config import load_config
                from agent.transports.codex_app_server import CodexAppServerClient
                from agent.transports.codex_app_server_session import CodexAppServerSession
                from agent.transports.native_child_scope import NativeNoToolsScope,child_scope_context
                runtime=(resolve_runtime_provider,load_config,CodexAppServerClient,CodexAppServerSession,NativeNoToolsScope,child_scope_context)
            resolver,config,Client,Session,NoTools,scope_context=runtime
            cfg=config().get('model',{})
            if not isinstance(cfg,dict):raise ValueError('Unsupported model configuration')
            provider=cfg.get('provider');model=cfg.get('default') or cfg.get('model')
            if provider!='openai-codex' or not isinstance(model,str) or not model:raise ValueError('Existing supported OAuth provider required')
            resolved=resolver(requested=provider,target_model=model)
            if resolved.get('provider')!='openai-codex' or resolved.get('api_mode')!='codex_app_server':raise ValueError('Unsupported OAuth route')
            receipt.update(provider=provider,api_mode='codex_app_server',requested_model=model,state='METADATA_RESOLVED',profile='existing Hermes profile; fresh task only')
            if not execute and not smoke:return {'ok':True,'receipt':receipt}
            if smoke:payload={'system':'This is one transport smoke. No task execution. Return only the exact JSON object {"ok":true}.','user':'Return {"ok":true}.'}
            if not isinstance(payload,dict) or set(payload)!={'system','user'} or any(not isinstance(payload[k],str) or not payload[k].strip() for k in ['system','user']):raise ValueError('Exact system/user payload required')
            receipt['input_sha256']=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            metadata={}
            class ObservedClient(Client):
                def request(self,method,params,*args,**kwargs):
                    # Supported thread-local model selection; no persistent config changes.
                    if method=='thread/start':params={**params,'model':model}
                    value=super().request(method,params,*args,**kwargs)
                    if method=='thread/start':
                        thread=value.get('thread') or {}
                        metadata.update(served_model=value.get('model') or thread.get('model'),model_provider=value.get('modelProvider') or thread.get('modelProvider'))
                    return value
            with tempfile.TemporaryDirectory(prefix='hermes-governance-',dir=os.environ.get('GOV_WORK_DIR')) as cwd:
                scope=NoTools(payload['system'])
                with scope_context(scope):
                    session=Session(cwd=cwd,client_factory=ObservedClient,isolate_native_memory=True,
                                    developer_instructions=payload['system'],initial_context='',initial_history=[],
                                    dynamic_tools=[],approval_callback=None,startup_timeout=30)
                try:
                    result=session.run_turn(payload['user'],turn_timeout=90,post_tool_quiet_timeout=20)
                    receipt.update(metadata)
                    receipt.update(thread_id=result.thread_id,turn_id=result.turn_id,tool_iterations=result.tool_iterations,
                                   isolation=session.memory_isolation_receipt,no_tools_scope=scope.receipt(),
                                   token_usage=result.token_usage_last,model_turns=1 if result.turn_id else 0)
                    if result.error or result.interrupted or result.tool_iterations:
                        receipt.update(state='BLOCKED',error='Hermes transport did not complete a tool-free isolated turn.',upstream_error_present=bool(result.error))
                        return {'ok':False,'receipt':receipt}
                    receipt['state']='PASS_SMOKE' if smoke else 'RECEIVED'
                    if smoke and json.loads(result.final_text)!={'ok':True}:raise ValueError('Unexpected smoke response')
                    return {'ok':True,'text':result.final_text,'receipt':receipt}
                finally:session.close()
    except Exception as error:
        receipt.update(state='BLOCKED',error_type=type(error).__name__)
        # Upstream exception text can contain auth material. Do not emit it.
        return {'ok':False,'receipt':receipt}
    finally:receipt['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    g=p.add_mutually_exclusive_group();g.add_argument('--doctor',action='store_true');g.add_argument('--smoke',action='store_true');g.add_argument('--execute',action='store_true')
    p.add_argument('--receipt',type=pathlib.Path)
    args=p.parse_args()
    def interrupted(signum, frame):
        raise TimeoutError('Transport cancelled')
    signal.signal(signal.SIGTERM, interrupted)
    payload=None
    if args.execute:
        raw=sys.stdin.read(65537)
        if len(raw.encode())>65536:raise SystemExit('Input exceeds bound')
        payload=json.loads(raw)
    result=transport(payload,execute=args.execute,smoke=args.smoke)
    if args.receipt:args.receipt.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
    return 0 if result['ok'] else 1

if __name__=='__main__':raise SystemExit(main())
