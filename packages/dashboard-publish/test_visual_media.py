"""Image media and the "visual" page type. Every acceptance here is refused by the gate before this change."""
import base64
import unittest

from admission import Refusal, admit, delivery, sha
from gate import run
import test_admission as base
from test_admission import RAW, SHELL

PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 24
JPEG = b'\xff\xd8\xff\xe0' + b'\0' * 24
WEBP = b'RIFF\x10\0\0\0WEBPVP8 ' + b'\0' * 16
MP3 = b'ID3\x04\0\0\0\0\0\0' + b'\0' * 24
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><defs><linearGradient id="g"/></defs>' \
      b'<rect width="4" height="4" fill="url(#g)" style="fill:url(#g)"/><use href="#g"/></svg>'
VISUAL_RAW = b'<meta name="dashboard-id" content="fixture-1"><body data-storage-key="dbx:fixture-1"><img data-nl-media="assets/a.webp">'
VISUAL_SHELL = VISUAL_RAW + b'<script>document.body.attachShadow({mode:"open"})</script>'


def row(name, data, kind=None):
    return {'file': 'assets/' + name, 'size': len(data), 'sha256': sha(data), **({'kind': kind} if kind else {})}


class MediaTest(unittest.TestCase):
    setUp = base.AdmissionTest.setUp

    def with_media(self, rows, media, **changes):
        return self.args | {'handoff': self.handoff | {'mediaManifest': rows}, 'media': media} | changes

    def visual(self, **changes):
        handoff = {k: v for k, v in self.handoff.items() if k not in ('answerRuntimeSha256', 'answerPersistence')}
        handoff |= {'type': 'visual', 'answerKeys': [], 'sourceHtmlSha256': sha(VISUAL_RAW), 'mediaManifest': [row('a.webp', WEBP, 'webp')]}
        return self.args | {'handoff': handoff | changes, 'raw': VISUAL_RAW, 'shell': VISUAL_SHELL, 'saved_keys': [],
                            'provider': {}, 'media': {'assets/a.webp': WEBP}}

    def refuse(self, code, args):
        with self.assertRaises(Refusal) as raised: admit(**args)
        self.assertEqual(raised.exception.code, code)

    def test_images_of_each_kind_are_accepted_on_an_answer_page(self):
        files = {'a.webp': (WEBP, 'webp'), 'b.png': (PNG, 'png'), 'c.jpg': (JPEG, 'jpeg'), 'd.jpeg': (JPEG, 'jpeg'),
                 'e.svg': (SVG, 'svg'), 'f.mp3': (MP3, 'mp3'), 'g.mp3': (MP3, None)}
        rows = [row(name, data, kind) for name, (data, kind) in files.items()]
        result = admit(**self.with_media(rows, {'assets/' + name: data for name, (data, _) in files.items()}))
        self.assertEqual(result['answerIdentity'], 'PASS')
        self.assertNotIn('pageType', result)

    def test_an_mp3_only_answer_page_is_unchanged(self):
        before = admit(**self.args)
        self.assertEqual(admit(**self.with_media([row('q.mp3', MP3)], None)), before)
        self.assertEqual(admit(**self.with_media([row('q.mp3', MP3)], {'assets/q.mp3': MP3})), before)

    def test_media_refusals(self):
        big = b'\x89PNG\r\n\x1a\n' + b'\0' * (2 * 1024 * 1024)
        cases = [('MEDIA_TOO_LARGE', [row('big.png', big, 'png')], {}),
                 ('MEDIA_TOO_LARGE', [row('big.svg', b' ' * (256 * 1024 + 1), 'svg')], {}),
                 ('MEDIA_KIND', [row('a.png', PNG, 'webp')], {'assets/a.png': PNG}),
                 ('MEDIA_KIND', [row('a.png', PNG)], {}),
                 ('MEDIA_KIND', [row('a.png', PNG, 'png') | {'file': 'media/a.png'}], {}),
                 ('MEDIA_KIND', [row('a.png', PNG, 'png')] * 2, {}),
                 ('MEDIA_COUNT', [row('i%d.png' % i, PNG, 'png') for i in range(41)], {}),
                 ('MEDIA_COUNT', [row('c%d.mp3' % i, MP3) for i in range(201)], {}),
                 ('MEDIA_BYTES', [row('a.png', PNG, 'png')], {'assets/a.png': PNG + b'x'}),
                 ('MEDIA_BYTES', [row('a.png', JPEG, 'png')], {'assets/a.png': JPEG}),
                 ('MEDIA_SVG_UNCHECKED', [row('a.svg', SVG, 'svg')], {})]
        for code, rows, media in cases:
            with self.subTest(code=code, rows=len(rows)): self.refuse(code, self.with_media(rows, media))
        self.refuse('HANDOFF_SCHEMA', self.with_media([row('a.gif', b'GIF89a', 'gif')], {}))

    def test_unsafe_svg_is_refused(self):
        ns = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
        bodies = ['<script>alert(1)</script>', '<rect onload="alert(1)"/>', '<rect ONCLICK="x()"/>',
                  '<image href="https://example.com/a.png"/>', '<use xlink:href="other.svg#a"/>',
                  '<rect style="fill:url(https://example.com/x)"/>', '<rect fill="url( \'http://e.com/x\')"/>',
                  '<style>@import "https://example.com/a.css";</style>', '<style>rect{fill:url(http://e.com)}</style>',
                  '<foreignObject><div/></foreignObject>', '<a href="javascript:alert(1)"><rect/></a>']
        payloads = ['<svg %s>%s</svg>' % (ns, body) for body in bodies] + [
            '<!DOCTYPE svg [<!ENTITY x "y">]><svg %s>&x;</svg>' % ns, '<?xml-stylesheet href="https://e.com/a.css"?><svg %s/>' % ns,
            '<html><script>x</script></html>', '<svg %s><rect' % ns]
        for payload in payloads:
            data = payload.encode()
            with self.subTest(payload=payload[:60]):
                self.refuse('MEDIA_SVG_UNSAFE', self.with_media([row('a.svg', data, 'svg')], {'assets/a.svg': data}))

    def test_a_visual_page_needs_no_clips_answers_or_runtime(self):
        result = admit(**self.visual())
        self.assertEqual((result['pageType'], result['answerRuntime'], result['answerIdentity']), ('visual', 'none', 'NOT_APPLICABLE'))
        self.assertEqual(result['servedShellSha256'], sha(VISUAL_SHELL))
        self.assertEqual(admit(**self.visual(mediaManifest=[]) | {'media': None})['pageType'], 'visual')

    def test_a_visual_page_keeps_every_other_page_rule(self):
        self.refuse('VISUAL_ANSWERS', self.visual(answerKeys=[{'key': 'note', 'kind': 'text'}]))
        self.refuse('VISUAL_ANSWERS', self.visual(answerRuntimeSha256=sha(b'r')))
        self.refuse('VISUAL_ANSWERS', self.visual(answerPersistence='PASS'))
        self.refuse('VISUAL_ANSWERS', self.visual() | {'saved_keys': [{'key': 'note', 'kind': 'text'}]})
        self.refuse('VISUAL_ANSWERS', self.visual() | {'shell': VISUAL_SHELL + b'<script>' + SHELL + b'</script>'})
        self.refuse('VISUAL_AUDIO', self.visual(mediaManifest=[row('q.mp3', MP3, 'mp3')]))
        self.refuse('SOURCE_SHA', self.visual(sourceHtmlSha256=sha(RAW)))
        self.refuse('DASHBOARD_ID', self.visual() | {'shell': VISUAL_SHELL.replace(b'dbx:fixture-1', b'dbx:other')})
        self.refuse('FIRST_IN_LINEAGE_UNAPPROVED', self.visual(design={'admission': 'FIRST_IN_LINEAGE', 'lineage': 'fixture', 'predecessorSha256': None}))
        self.refuse('LINEAGE_EXISTS', self.visual() | {'deliveries': {'fixture': [{'accepted': True}]}})
        self.refuse('ARTIFACT_TOO_LARGE', self.visual() | {'artifact': b'x' * (1048576 + 1)})
        self.refuse('DEPLOY_LOCK', self.visual() | {'owner_pid': self.args['owner_pid'] + 1})
        self.refuse('MEDIA_SVG_UNCHECKED', self.visual(mediaManifest=[row('a.svg', SVG, 'svg')]) | {'media': None})

    def test_a_visual_page_has_no_answer_delivery_yet(self):
        args = self.visual()
        with self.assertRaises(Refusal) as raised:
            delivery(path=self.root / 'visual.json', handoff=args['handoff'], admission=admit(**args), shell=VISUAL_SHELL,
                     artifact=b'{}', staging={'mode': 'unlisted-candidate', 'servedShellSha256': sha(VISUAL_SHELL)},
                     url='https://fixture.invalid/?d=fixture-1', approved_origins=['https://fixture.invalid'],
                     existing_rows=0, runtime_config=self.runtime_config, deliveries={})
        self.assertEqual(raised.exception.code, 'VISUAL_DELIVERY_UNSUPPORTED')
        self.assertFalse((self.root / 'visual.json').exists())

    def test_the_json_adapter_carries_media_bytes(self):
        args = self.visual(mediaManifest=[row('a.svg', SVG, 'svg')])
        request = {'handoff': args['handoff'], 'rawBase64': base64.b64encode(VISUAL_RAW).decode(),
                   'shellBase64': base64.b64encode(VISUAL_SHELL).decode(), 'dashboardId': 'fixture-1', 'savedKeys': [],
                   'deliveries': {}, 'provider': {}, 'artifactBase64': base64.b64encode(b'{}').decode(),
                   'lock': str(self.lock), 'ownerPid': self.args['owner_pid'], 'runtimeConfig': str(self.runtime_config)}
        with self.assertRaises(Refusal) as raised: run(request)
        self.assertEqual(raised.exception.code, 'MEDIA_SVG_UNCHECKED')
        self.assertEqual(run(request | {'mediaBase64': {'assets/a.svg': base64.b64encode(SVG).decode()}})['pageType'], 'visual')


if __name__ == '__main__':
    unittest.main()
