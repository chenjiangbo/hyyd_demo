import ast
import unittest
from pathlib import Path


source = Path(__file__).resolve().parents[1] / 'collector.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'apply_media_ack')
namespace = {}
exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), str(source), 'exec'), namespace)
apply_media_ack = namespace['apply_media_ack']


class MediaAckTests(unittest.TestCase):
    def test_ack_clears_only_confirmed_media(self):
        pending = {'a': {'one', 'two'}}
        inflight = {'a': 'one'}
        checked = {('a', 'one'): 12, ('a', 'two'): 13}
        apply_media_ack({'sourceConversationId': 'a', 'sourceMessageId': 'one', 'pendingAttachmentIds': []}, pending, inflight, checked)
        self.assertEqual(pending, {'a': {'two'}})
        self.assertEqual(inflight, {})
        self.assertEqual(checked, {('a', 'two'): 13})

    def test_unfinished_media_stays_pending(self):
        pending, inflight, checked = {'a': {'one'}}, {'a': 'one'}, {('a', 'one'): 12}
        apply_media_ack({'sourceConversationId': 'a', 'sourceMessageId': 'one', 'pendingAttachmentIds': ['image']}, pending, inflight, checked)
        self.assertEqual(pending, {'a': {'one'}})
        self.assertEqual(inflight, {})
        self.assertEqual(checked, {('a', 'one'): 12})

    def test_unexpected_ack_does_not_change_state(self):
        pending, inflight, checked = {'a': {'one'}}, {'a': 'one'}, {}
        with self.assertRaises(ValueError):
            apply_media_ack({'sourceConversationId': 'a', 'sourceMessageId': 'other', 'pendingAttachmentIds': []}, pending, inflight, checked)
        self.assertEqual((pending, inflight), ({'a': {'one'}}, {'a': 'one'}))


if __name__ == '__main__':
    unittest.main()
