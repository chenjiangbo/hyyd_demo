import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "vendor"))
from wechatauto.records import diagnose_merged_forward, parse_merged_forward, parse_pat_message


class MergedForwardDiagnosticsTest(unittest.TestCase):
    def test_identifies_outer_and_embedded_xml_errors(self):
        self.assertTrue(diagnose_merged_forward("<msg><recorditem>").startswith("outer_xml_invalid:"))
        self.assertTrue(diagnose_merged_forward("<msg><recorditem><![CDATA[<recordinfo>]]></recorditem></msg>").startswith("embedded_xml_invalid:"))

    def test_distinguishes_missing_records_from_valid_content(self):
        self.assertEqual(diagnose_merged_forward("<msg><recorditem/></msg>"), "recordinfo_missing")
        self.assertEqual(diagnose_merged_forward("<msg><recorditem><recordinfo/></recorditem></msg>"), "datalist_missing")
        self.assertEqual(diagnose_merged_forward("<msg><recorditem><recordinfo><datalist/></recordinfo></recorditem></msg>"), "source_reread_failed_or_content_differs")

    def test_pat_card_is_not_a_file_or_other_app_message(self):
        self.assertEqual(parse_pat_message('<msg><appmsg><title>小王 拍了拍我</title><type>62</type><patinfo/></appmsg></msg>'), '小王 拍了拍我')
        self.assertIsNone(parse_pat_message('<msg><appmsg><title>文档.pdf</title><type>6</type></appmsg></msg>'))

    def test_group_note_sender_prefix_preserves_note_items(self):
        content = ('wxid_sender123:\n<?xml version="1.0"?><msg><appmsg><type>24</type>'
                   '<recorditem><![CDATA[<recordinfo><datalist count="2">'
                   '<dataitem datatype="1"><datadesc>陪诊文字</datadesc></dataitem>'
                   '<dataitem datatype="2"><datasize>123</datasize></dataitem>'
                   '</datalist></recordinfo>]]></recorditem></appmsg></msg>')
        result = parse_merged_forward(content)
        self.assertIsNotNone(result)
        self.assertEqual(result['app_message_type'], '24')
        self.assertEqual([item['type'] for item in result['items']], ['text', 'image'])
        self.assertEqual(result['items'][0]['text'], '陪诊文字')
        self.assertEqual(result['items'][1]['media']['datasize'], '123')


if __name__ == "__main__":
    unittest.main()
