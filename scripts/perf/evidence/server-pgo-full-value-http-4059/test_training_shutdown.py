import http.client, socket, subprocess, sys, unittest
from training_shutdown import begin_training_shutdown, training_transport_success

class BrokenClose:
    def close(self):
        raise OSError("injected close failure")

class TrainingShutdownTests(unittest.TestCase):
    def process(self, code):
        program="import signal,sys,time; signal.signal(signal.SIGINT,lambda *_:sys.exit(%d)); print('ready',flush=True); time.sleep(20)" % code
        process=subprocess.Popen([sys.executable,"-c",program],stdout=subprocess.PIPE,text=True)
        self.assertEqual(process.stdout.readline().strip(),"ready")
        self.addCleanup(process.stdout.close)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        return process

    def test_failure_before_connection_assignment_still_exits(self):
        process=self.process(0)
        self.assertEqual(begin_training_shutdown(None,None,process),[])
        self.assertEqual(process.wait(timeout=3),0)

    def test_close_failure_still_closes_upload_and_signals(self):
        left,right=socket.socketpair();self.addCleanup(right.close)
        conn=http.client.HTTPConnection("localhost");conn.sock=left
        process=self.process(0)
        errors=begin_training_shutdown(conn,BrokenClose(),process)
        self.assertEqual(left.fileno(),-1)
        self.assertEqual(process.wait(timeout=3),0)
        self.assertEqual(len(errors),1)
        self.assertIn("injected close failure",errors[0])

    def test_nonzero_normal_exit_cannot_qualify_successful_responses(self):
        process=self.process(7)
        begin_training_shutdown(None,None,process)
        result={"exitCode":process.wait(timeout=3),"loadSuccess":True,"cacheReplaySuccess":True}
        self.assertFalse(training_transport_success(result))
        result["exitCode"]=0
        self.assertTrue(training_transport_success(result))
        result["error"]="upload failed"
        self.assertFalse(training_transport_success(result))
