"""Synthetic wrapper checks only; never a live model call."""
import contextlib,importlib.util,pathlib,types,unittest
p=pathlib.Path(__file__).with_name('hermes_oauth.py')
spec=importlib.util.spec_from_file_location('governance_hermes',p);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class Runtime:
 def __init__(self):self.sessions=[];self.turns=0
 def resolver(self,**kwargs):return {'provider':'openai-codex','api_mode':'codex_app_server'}
 def config(self):return {'model':{'provider':'openai-codex','default':'synthetic'}}
 class Client:
  def request(self,method,params,*a,**kw):return {'model':'synthetic','modelProvider':'openai'}
 class Scope:
  def __init__(self,instructions):self.instructions=instructions
  def receipt(self):return {'tool_policy':'none','max_authorized_actions':0}
 @contextlib.contextmanager
 def scope_context(self,scope):yield
 def session(self,**kwargs):
  self.sessions.append(kwargs);kwargs['client_factory']().request('thread/start',{})
  owner=self
  class Session:
   memory_isolation_receipt={'use_memories':False,'generate_memories':False,'thread_memory_mode':'disabled'}
   def run_turn(self,user,**kwargs):
    owner.turns+=1
    return types.SimpleNamespace(thread_id='synthetic',turn_id='synthetic',tool_iterations=0,token_usage_last={},error=None,interrupted=False,final_text='{"ok":true}')
   def close(self):pass
  return Session()
 def ports(self):return (self.resolver,self.config,self.Client,self.session,self.Scope,self.scope_context)
class Tests(unittest.TestCase):
 def test_doctor_has_zero_turns(self):
  r=Runtime();out=mod.transport(None,runtime=r.ports());self.assertTrue(out['ok']);self.assertEqual(r.turns,0);self.assertEqual(r.sessions,[])
 def test_one_smoke_no_history_tools_context(self):
  r=Runtime();out=mod.transport(None,smoke=True,runtime=r.ports());self.assertEqual(r.turns,1);self.assertEqual(out['receipt']['served_model'],'synthetic');self.assertEqual(r.sessions[0]['initial_history'],[]);self.assertEqual(r.sessions[0]['dynamic_tools'],[]);self.assertTrue(r.sessions[0]['isolate_native_memory'])
 def test_unsupported_provider_has_no_turn(self):
  r=Runtime();r.config=lambda:{'model':{'provider':'other','default':'synthetic'}};out=mod.transport(None,smoke=True,runtime=r.ports());self.assertFalse(out['ok']);self.assertEqual(r.turns,0)
 def test_invalid_input_and_exception_do_not_expose_text(self):
  r=Runtime();out=mod.transport({'system':'bad','user':'u','extra':'forbidden'},execute=True,runtime=r.ports());self.assertFalse(out['ok']);self.assertNotIn('forbidden',str(out));self.assertEqual(r.turns,0)
if __name__=='__main__':unittest.main()
