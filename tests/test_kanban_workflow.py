"""Exercise workflow gates and native SQL bypass attempts without model calls."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'skills/pr-cycle/scripts'))
spec = importlib.util.spec_from_file_location('workflow', ROOT / 'skills/pr-cycle/scripts/kanban_workflow.py')
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)
HEAD = 'a' * 40
NEXT = 'b' * 40


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'db.sqlite'
        self.project, self.task, self.workspace = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE tasks(id BLOB PRIMARY KEY,project_id BLOB,title TEXT,description TEXT,status TEXT);
            CREATE TABLE workspaces(id BLOB PRIMARY KEY,task_id BLOB,container_ref TEXT);
            CREATE TABLE sessions(id BLOB PRIMARY KEY,workspace_id BLOB,executor TEXT);
            CREATE TABLE execution_processes(id BLOB PRIMARY KEY,session_id BLOB,run_reason TEXT,
                executor_action TEXT,status TEXT,exit_code INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE execution_process_logs(execution_id BLOB,logs TEXT,inserted_at TEXT DEFAULT CURRENT_TIMESTAMP);
        ''')
        self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?)', (self.task.bytes,self.project.bytes,'Task','Original description','todo'))
        self.db.execute('INSERT INTO workspaces VALUES(?,?,?)', (self.workspace.bytes,self.task.bytes,'C:/worktree'))
        self.db.commit()
        workflow.install(self.path)
        self.call('begin_plan')
        self.plan = self.session('plan')

    def call(self, action='read', **payload):
        return workflow.execute(self.path, {'action':action,'project_id':str(self.project),'task_id':str(self.task),**payload})

    def flow(self):
        return self.call()['workflows'][0]

    def session(self, role):
        value = uuid.uuid4()
        workspace = self.workspace
        if role == 'implementation_child':
            workspace = uuid.uuid4()
            self.db.execute('INSERT INTO workspaces VALUES(?,?,?)', (workspace.bytes,self.task.bytes,'C:/child/'+str(workspace)))
        self.db.execute('INSERT INTO sessions VALUES(?,?,?)', (value.bytes,workspace.bytes,'CLAUDE_CODE'))
        self.db.commit()
        self.call('bind_session', role=role, session_id=str(value), workspace_id=str(workspace))
        return value

    def plan_result(self, risk='P1', children=None, plan='Implement the requested feature with regression tests'):
        self.call('prepare_launch',role='plan',session_id=str(self.plan),executor='CLAUDE_CODE')
        process = self.insert_process(self.plan,'PR_CYCLE_PLAN')
        self.call('mark_run',role='plan',session_id=str(self.plan),process_id=str(process),prompt='Plan and explain risk')
        self.db.execute("UPDATE execution_processes SET status='completed',exit_code=0 WHERE id=?",(process.bytes,))
        self.db.commit()
        self.call('save_plan',plan=plan,risk=risk,children=children or [],expected_revision=self.flow()['revision'],
                  role='plan',session_id=str(self.plan),process_id=str(process))
        return process

    def plan_ready(self, risk='P1', children=None):
        self.plan_result(risk,children)
        self.call('approve_plan', expected_revision=self.flow()['revision'])

    def insert_process(self, session, variant, process=None):
        process = process or uuid.uuid4()
        action = {'typ':{'type':'CodingAgentFollowUpRequest','executor_profile_id':{'executor':'CLAUDE_CODE','variant':variant}}}
        try:
            self.db.execute('INSERT INTO execution_processes(id,session_id,run_reason,executor_action,status,exit_code) VALUES(?,?,?,?,?,?)',
                            (process.bytes,session.bytes,'codingagent',json.dumps(action),'running',None))
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return process

    def agent_result(self, role, session, head=HEAD, passed=True, child_id=None):
        self.call('prepare_launch', role=role, session_id=str(session), executor='CLAUDE_CODE',child_id=child_id)
        process = self.insert_process(session, 'PR_CYCLE_' + ('IMPLEMENTATION' if role=='implementation_child' else role.upper()))
        self.call('mark_run',role=role,session_id=str(session),process_id=str(process),head_sha=head,prompt='Stage instructions',child_id=child_id)
        self.db.execute("UPDATE execution_processes SET status='completed',exit_code=0 WHERE id=?", (process.bytes,))
        self.db.commit()
        self.call('record_result',role=role,session_id=str(session),process_id=str(process),head_sha=head,
                  passed=passed,summary='Verified result',details='Test evidence',child_id=child_id)
        return process

    def reviewed(self):
        self.plan_ready()
        self.agent_result('implementation', self.plan)
        self.functional = self.session('functional')
        self.agent_result('functional', self.functional)
        self.security = self.session('security')
        self.agent_result('security', self.security)

    def test_plan_revision_and_native_start_guards(self):
        with self.assertRaisesRegex(ValueError,'stage'):
            self.call('prepare_launch',role='implementation',session_id=str(self.plan),executor='CLAUDE_CODE')
        with self.assertRaisesRegex(sqlite3.IntegrityError,'launch denied'):
            self.insert_process(self.plan,'PR_CYCLE_IMPLEMENTATION')
        self.plan_ready()
        self.db.execute("UPDATE tasks SET description='Revised requirement' WHERE id=?",(self.task.bytes,))
        self.db.commit()
        self.assertIsNone(self.flow()['approved_revision'])
        with self.assertRaisesRegex(ValueError,'current plan'):
            self.call('approve_plan',expected_revision=self.flow()['revision'])
        self.plan_result(plan='Changed plan')
        with self.assertRaisesRegex(ValueError,'current plan'):
            self.call('approve_plan',expected_revision=1)
        self.call('approve_plan',expected_revision=self.flow()['revision'])
        self.call('prepare_launch',role='implementation',session_id=str(self.plan),executor='CLAUDE_CODE')
        with self.assertRaisesRegex(sqlite3.IntegrityError,'launch denied'):
            self.insert_process(self.plan,'DEFAULT')
        self.insert_process(self.plan,'PR_CYCLE_IMPLEMENTATION')
        with self.assertRaisesRegex(sqlite3.IntegrityError,'launch denied'):
            self.insert_process(self.plan,'PR_CYCLE_IMPLEMENTATION')

    def test_launch_intent_survives_permit_cancel_and_is_explicitly_cleared(self):
        known = str(uuid.uuid4())
        self.call('prepare_launch',role='plan',session_id=str(self.plan),executor='CLAUDE_CODE',
                  prompt='Plan snapshot',head_sha=HEAD,known_process_ids=[known])
        intent = self.flow()['launch_intent']
        self.assertEqual(intent, {'session_id':str(self.plan),'role':'plan','child_id':None,
            'head_sha':HEAD,'prompt':'Plan snapshot','revision':0,'known_process_ids':[known]})
        self.call('cancel_launch')
        self.assertEqual(self.flow()['launch_intent'],intent)
        with self.assertRaisesRegex(ValueError,'unresolved'):
            self.call('prepare_launch',role='plan',session_id=str(self.plan),executor='CLAUDE_CODE')
        self.call('pause')
        self.assertEqual(self.flow()['launch_intent'],intent)
        self.call('cancel_intent')
        self.assertNotIn('launch_intent',self.flow())

    def test_mark_run_clears_matching_launch_intent(self):
        self.call('prepare_launch',role='plan',session_id=str(self.plan),executor='CLAUDE_CODE',
                  prompt='Plan snapshot',known_process_ids=[])
        process = self.insert_process(self.plan,'PR_CYCLE_PLAN')
        self.call('cancel_launch')
        self.call('mark_run',role='plan',session_id=str(self.plan),process_id=str(process),prompt='Plan snapshot')
        self.assertNotIn('launch_intent',self.flow())
        self.assertEqual(self.flow()['runs'][0]['process_id'],str(process))
        self.call('mark_run',role='plan',session_id=str(self.plan),process_id=str(process),prompt='Plan snapshot')
        self.assertEqual(len(self.flow()['runs']),1)

    def test_global_running_count_includes_paused_other_projects(self):
        self.call('prepare_launch',role='plan',session_id=str(self.plan),executor='CLAUDE_CODE')
        process = self.insert_process(self.plan,'PR_CYCLE_PLAN')
        self.call('pause')
        other_project, other_task, other_workspace, other_session = [uuid.uuid4() for _ in range(4)]
        self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?)',(other_task.bytes,other_project.bytes,'Other','Description','todo'))
        self.db.execute('INSERT INTO workspaces VALUES(?,?,?)',(other_workspace.bytes,other_task.bytes,'C:/other'))
        self.db.execute('INSERT INTO sessions VALUES(?,?,?)',(other_session.bytes,other_workspace.bytes,'CLAUDE_CODE'))
        self.db.commit()
        def other(action, **values):
            return workflow.execute(self.path,dict(action=action,project_id=str(other_project),task_id=str(other_task),**values))
        other('begin_plan')
        other('bind_session',role='plan',session_id=str(other_session),workspace_id=str(other_workspace))
        other('prepare_launch',role='plan',session_id=str(other_session),executor='CLAUDE_CODE')
        self.insert_process(other_session,'PR_CYCLE_PLAN')
        other('pause')
        self.assertEqual(workflow.execute(self.path,{'action':'running_count'}),2)
        self.db.execute("UPDATE execution_processes SET status='completed',exit_code=0 WHERE id=?",(process.bytes,))
        self.db.commit()
        self.assertEqual(workflow.execute(self.path,{'action':'running_count'}),1)

    def test_independent_roles_and_failed_review_returns_to_implementation(self):
        self.plan_ready()
        self.agent_result('implementation',self.plan)
        with self.assertRaisesRegex(ValueError,'independent'):
            self.call('bind_session',role='functional',session_id=str(self.plan),workspace_id=str(self.workspace))
        reviewer = self.session('functional')
        with self.assertRaisesRegex(ValueError,'independent'):
            self.call('bind_session',role='security',session_id=str(reviewer),workspace_id=str(self.workspace))
        self.agent_result('functional',reviewer,passed=False)
        self.assertEqual(self.flow()['stage'],'implementation')
        self.assertIsNone(self.flow()['functional'])
        self.assertEqual(self.flow()['events'][-1]['details'],'Test evidence')

    def test_review_needs_completed_run_and_exact_commit(self):
        self.plan_ready()
        self.agent_result('implementation',self.plan)
        reviewer = self.session('functional')
        self.call('prepare_launch',role='functional',session_id=str(reviewer),executor='CLAUDE_CODE')
        process = self.insert_process(reviewer,'PR_CYCLE_FUNCTIONAL')
        self.call('mark_run',role='functional',session_id=str(reviewer),process_id=str(process),head_sha=HEAD,prompt='Review')
        args = dict(role='functional',session_id=str(reviewer),process_id=str(process),head_sha=HEAD,passed=True,summary='Pass')
        with self.assertRaisesRegex(ValueError,'successfully completed'):
            self.call('record_result',**args)
        self.db.execute("UPDATE execution_processes SET status='completed',exit_code=0 WHERE id=?",(process.bytes,))
        self.db.commit()
        with self.assertRaisesRegex(ValueError,'changed since'):
            self.call('record_result',**{**args,'head_sha':NEXT})
        self.call('record_result',**args)
        with self.assertRaises(ValueError):
            self.call('record_result',**args)

    def test_human_approval_and_merge_are_separate(self):
        self.reviewed()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE tasks SET status='done' WHERE id=?",(self.task.bytes,))
        self.db.rollback()
        self.call('record_pr',url='https://github.com/team/repo/pull/1',head_sha=HEAD,base_branch='main')
        with self.assertRaisesRegex(ValueError,'human approval'):
            self.call('complete',head_sha=HEAD,merged=True)
        with self.assertRaises(ValueError):
            self.call('human_approve',head_sha=NEXT)
        self.call('human_approve',head_sha=HEAD)
        with self.assertRaises(ValueError):
            self.call('complete',head_sha=HEAD,merged=False)
        self.call('complete',head_sha=HEAD,merged=True)
        self.db.execute("UPDATE tasks SET status='done' WHERE id=?",(self.task.bytes,))
        self.db.commit()
        self.assertEqual(self.flow()['stage'],'done')

    def test_p2_integration_requires_all_children_and_new_reviews(self):
        self.plan_ready('P2',[{'id':'one','title':'First','base_branch':'integration'},
                              {'id':'two','title':'Second','depends_on':['one'],'base_branch':'integration'}])
        self.agent_result('implementation_child',self.session('implementation_child'),child_id='one')
        self.agent_result('implementation_child',self.session('implementation_child'),head=NEXT,child_id='two')
        self.agent_result('implementation',self.plan)
        functional, security = self.session('functional'), self.session('security')
        self.agent_result('functional',functional)
        self.agent_result('security',security)
        with self.assertRaisesRegex(ValueError,'dependency'):
            self.call('record_pr',child_id='two',url='https://github.com/t/r/pull/2',head_sha=NEXT,base_branch='integration')
        self.call('record_pr',child_id='one',url='https://github.com/t/r/pull/1',head_sha=HEAD,base_branch='integration')
        self.assertEqual(self.flow()['stage'],'pr')
        self.call('record_pr',child_id='two',url='https://github.com/t/r/pull/2',head_sha=NEXT,base_branch='integration')
        self.call('record_integration',head_sha=NEXT,pr_url='https://github.com/t/r/pull/3')
        self.assertEqual(self.flow()['stage'],'functional')
        with self.assertRaises(ValueError):
            self.call('human_approve',head_sha=NEXT)
        self.agent_result('functional',functional,head=NEXT)
        self.agent_result('security',security,head=NEXT)
        self.call('record_pr',head_sha=NEXT,url='https://github.com/t/r/pull/3',base_branch='main')
        self.assertEqual(self.flow()['stage'],'human')
        self.call('invalidate',head_sha=HEAD,message='Dirty integration requires implementation')
        self.assertEqual(self.flow()['stage'],'implementation')
        self.assertIsNotNone(self.flow()['integration'])

    def test_publishing_dependency_cannot_target_unpublished_branch(self):
        with self.assertRaisesRegex(ValueError, 'Publishing children'):
            workflow.children([{'id':'helper','title':'Helper','publish_pr':False},
                               {'id':'pr','title':'PR','depends_on':['helper']}])

    def test_settings_history_runtime_and_install_are_persistent(self):
        workflow.install(self.path)
        self.assertEqual(len(list(self.path.parent.glob('db.before-pr-cycle-workflow-*'))),1)
        self.call('configure',prompts={'plan':'Project planning instructions'})
        self.call('configure_task',prompts={'security':'Task security instructions'})
        self.assertEqual(self.call()['settings']['prompts']['plan'],'Project planning instructions')
        self.assertEqual(self.flow()['prompts']['security'],'Task security instructions')
        self.assertEqual(self.call('runtime')['task']['description'],'Original description')
        with self.assertRaises(ValueError):
            self.call('save_plan',plan='x',risk='P2',expected_revision=0,children=[{'id':'x','title':'x','depends_on':['x']}])
        with self.assertRaises(ValueError):
            self.call('read',project_id='not-a-uuid')
        self.assertEqual(self.flow()['stage'],'plan')

    def test_initial_plan_permit_auto_binds_and_cannot_be_replayed(self):
        task, workspace, session = uuid.uuid4(),uuid.uuid4(),uuid.uuid4()
        self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?)',(task.bytes,self.project.bytes,'Other','Description','todo'))
        self.db.execute('INSERT INTO workspaces VALUES(?,?,?)',(workspace.bytes,task.bytes,'C:/other'))
        self.db.execute('INSERT INTO sessions VALUES(?,?,?)',(session.bytes,workspace.bytes,'CLAUDE_CODE'))
        self.db.commit()
        self.call('begin_plan',task_id=str(task))
        self.call('prepare_launch',task_id=str(task),role='plan',executor='CLAUDE_CODE')
        self.insert_process(session,'PR_CYCLE_PLAN')
        row = self.db.execute('SELECT role FROM pr_cycle_workflow_sessions WHERE session_id=?',(session.bytes,)).fetchone()
        self.assertEqual(row[0],'plan')
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_process(session,'PR_CYCLE_PLAN')

    def test_unmanaged_native_launch_is_blocked_but_setup_is_allowed(self):
        task, workspace, session = uuid.uuid4(),uuid.uuid4(),uuid.uuid4()
        self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?)',(task.bytes,self.project.bytes,'New','Description','todo'))
        self.db.execute('INSERT INTO workspaces VALUES(?,?,?)',(workspace.bytes,task.bytes,'C:/new'))
        self.db.execute('INSERT INTO sessions VALUES(?,?,?)',(session.bytes,workspace.bytes,'CLAUDE_CODE'))
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_process(session,'DEFAULT')
        self.db.execute('INSERT INTO execution_processes(id,session_id,run_reason,executor_action,status) VALUES(?,?,?,?,?)',
                        (uuid.uuid4().bytes,session.bytes,'setupscript','{}','completed'))
        self.db.commit()

    def test_p1_collaborators_do_not_require_child_prs(self):
        self.plan_ready('P1',[{'id':'helper','title':'Test implementation','publish_pr':False}])
        helper = self.session('implementation_child')
        self.agent_result('implementation_child',helper,child_id='helper')
        self.agent_result('implementation',self.plan)
        self.agent_result('functional',self.session('functional'))
        self.agent_result('security',self.session('security'))
        self.call('record_pr',head_sha=HEAD,url='https://github.com/t/r/pull/1',base_branch='main')
        self.assertEqual(self.flow()['stage'],'human')
        self.call('invalidate',head_sha=NEXT,message='Implementation changed after review')
        self.assertEqual(self.flow()['stage'],'implementation')
        self.assertIsNone(self.flow()['functional'])
        self.assertTrue(self.flow()['prs'][0]['stale'])

    def test_runtime_returns_bound_identity_and_raw_logs(self):
        self.plan_ready()
        process = self.agent_result('implementation',self.plan)
        self.db.execute('INSERT INTO execution_process_logs(execution_id,logs) VALUES(?,?)',
                        (process.bytes,'{"Stdout":"result"}'))
        self.db.commit()
        result = self.call('runtime',process_id=str(process))
        self.assertEqual(result['workflow']['plan_session_id'],str(self.plan))
        self.assertEqual(result['processes'][0]['role'],'plan')
        self.assertIn('result',result['logs'])
        with self.assertRaises(ValueError):
            self.call('runtime',process_id=str(uuid.uuid4()))

    def test_plan_requires_current_completed_planning_agent_evidence(self):
        args = dict(plan='Manual text',risk='P1',expected_revision=0)
        with self.assertRaisesRegex(ValueError,'planning agent'):
            self.call('save_plan',**args)
        with self.assertRaisesRegex(ValueError,'planning agent'):
            self.call('save_plan',**args,role='implementation',process_id=str(uuid.uuid4()))
        self.call('prepare_launch',role='plan',session_id=str(self.plan),executor='CLAUDE_CODE')
        process = self.insert_process(self.plan,'PR_CYCLE_PLAN')
        self.call('mark_run',role='plan',session_id=str(self.plan),process_id=str(process),prompt='Plan')
        evidence = dict(role='plan',session_id=str(self.plan),process_id=str(process))
        with self.assertRaisesRegex(ValueError,'running agent'):
            self.call('save_plan',**args,**evidence)
        self.db.execute("UPDATE execution_processes SET status='failed',exit_code=1 WHERE id=?",(process.bytes,))
        self.db.commit()
        with self.assertRaisesRegex(ValueError,'successfully completed'):
            self.call('save_plan',**args,**evidence)
        self.db.execute("UPDATE execution_processes SET status='completed',exit_code=0 WHERE id=?",(process.bytes,))
        self.db.commit()
        self.call('save_plan',**args,**evidence)
        self.assertEqual(self.flow()['plan_revision'],1)
        with self.assertRaisesRegex(ValueError,'already collected'):
            self.call('save_plan',**{**args,'expected_revision':1},**evidence)

    def test_automation_authorization_pause_resume_and_error_are_persistent(self):
        self.assertEqual(workflow.execute(self.path,{'action':'list_automated'}),[])
        with self.assertRaisesRegex(ValueError,'not been authorized'):
            self.call('resume')
        self.call('authorize_start')
        expected = [{'project_id':str(self.project),'task_id':str(self.task)}]
        self.assertEqual(workflow.execute(self.path,{'action':'list_automated'}),expected)
        self.call('pause',reason='Wait for budget')
        self.assertEqual(workflow.execute(self.path,{'action':'list_automated'}),[])
        with self.assertRaisesRegex(ValueError,'paused'):
            self.call('prepare_launch',role='plan',session_id=str(self.plan),executor='CLAUDE_CODE')
        self.call('resume')
        self.call('prepare_launch',role='plan',session_id=str(self.plan),executor='CLAUDE_CODE')
        self.call('error',message='Provider unavailable')
        with self.assertRaisesRegex(sqlite3.IntegrityError,'launch denied'):
            self.insert_process(self.plan,'PR_CYCLE_PLAN')
        self.call('configure_task',prompts={'plan':'Keep error visible'})
        workflow.install(self.path)
        self.assertEqual(self.flow()['error'],'Provider unavailable')
        self.assertEqual(self.flow()['automation'],{'enabled':True,'paused':True,'reason':'Provider unavailable'})
        with self.assertRaisesRegex(ValueError,'Resume'):
            self.call('authorize_start')
        self.call('resume')
        self.assertIsNone(self.flow()['error'])
        self.assertEqual(workflow.execute(self.path,{'action':'list_automated'}),expected)
        self.plan_ready()
        self.assertTrue(self.flow()['automation']['enabled'])
        self.assertEqual(workflow.execute(self.path,{'action':'list_automated'}),expected)

    def test_automated_listing_covers_projects_and_stops_at_human_or_cancelled(self):
        other_project,other_task = uuid.uuid4(),uuid.uuid4()
        self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?)',(other_task.bytes,other_project.bytes,'Other','Other plan','todo'))
        self.db.commit()
        other = {'project_id':str(other_project),'task_id':str(other_task)}
        workflow.execute(self.path,{**other,'action':'begin_plan'})
        workflow.execute(self.path,{**other,'action':'authorize_start'})
        self.call('authorize_start')
        self.assertEqual(len(workflow.execute(self.path,{'action':'list_automated'})),2)
        self.reviewed()
        self.call('record_pr',url='https://github.com/team/repo/pull/1',head_sha=HEAD,base_branch='main')
        self.assertEqual(workflow.execute(self.path,{'action':'list_automated'}),[other])
        self.db.execute("UPDATE tasks SET status='cancelled' WHERE id=?",(other_task.bytes,))
        self.db.commit()
        self.assertEqual(workflow.execute(self.path,{'action':'list_automated'}),[])

    def test_marking_existing_run_does_not_clear_scheduler_error(self):
        self.call('authorize_start')
        self.call('prepare_launch',role='plan',session_id=str(self.plan),executor='CLAUDE_CODE')
        process=self.insert_process(self.plan,'PR_CYCLE_PLAN')
        self.call('error',message='Lost response while launching')
        self.call('mark_run',role='plan',session_id=str(self.plan),process_id=str(process),prompt='Recovered launch')
        self.assertEqual(self.flow()['error'],'Lost response while launching')
        self.assertTrue(self.flow()['automation']['paused'])


if __name__ == '__main__':
    unittest.main()
