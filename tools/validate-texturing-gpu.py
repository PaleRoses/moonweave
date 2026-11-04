#!/usr/bin/env python3
"""Driver-compile and render real Moonweave shaders in native surfaceless EGL.

No browser, browser automation, downloaded GL implementation or Python GL package.
Requires system Mesa EGL exposing GLES3 entry points, numpy and Pillow.
This validates a native driver, not the browser's WebGL security/driver layer.
"""
import base64
import ctypes as C
import ctypes.util
from hashlib import sha256
import json
import os
import struct
from pathlib import Path
import subprocess
import sys
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'validation' / 'native-texturing'
OUTPUT.mkdir(parents=True, exist_ok=True)
os.environ.setdefault('MESA_SHADER_CACHE_DISABLE', 'true')
EGL = C.CDLL(ctypes.util.find_library('EGL'))

def egl(name, restype, *args):
    fn = getattr(EGL, name)
    fn.restype, fn.argtypes = restype, args
    return fn

getproc = egl('eglGetProcAddress', C.c_void_p, C.c_char_p)
geterror = egl('eglGetError', C.c_uint)

def gl(name, restype, *args):
    address = getproc(name.encode())
    if not address:
        raise RuntimeError(f'Missing native GL entry point {name}')
    return C.CFUNCTYPE(restype, *args)(address)

def require(value, operation):
    if not value:
        raise RuntimeError(f'{operation} failed; EGL error {hex(geterror())}')
    return value

getdisplay = C.CFUNCTYPE(C.c_void_p, C.c_uint, C.c_void_p, C.POINTER(C.c_int))(getproc(b'eglGetPlatformDisplayEXT'))
display = require(getdisplay(0x31DD, None, None), 'surfaceless display')
major, minor = C.c_int(), C.c_int()
require(egl('eglInitialize', C.c_uint, C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int))(display, C.byref(major), C.byref(minor)), 'eglInitialize')
require(egl('eglBindAPI', C.c_uint, C.c_uint)(0x30A0), 'bind OpenGL ES')
attributes = (C.c_int * 15)(0x3033, 1, 0x3040, 0x40, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, 0x3025, 24, 0x3038)
config, count = C.c_void_p(), C.c_int()
require(egl('eglChooseConfig', C.c_uint, C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_void_p), C.c_int, C.POINTER(C.c_int))(display, attributes, C.byref(config), 1, C.byref(count)), 'choose EGL config')
require(count.value, 'GLES3 config availability')
context = require(egl('eglCreateContext', C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p, C.POINTER(C.c_int))(display, config, None, (C.c_int * 3)(0x3098, 3, 0x3038)), 'create GLES3 context')
SIZE = 512
surface = require(egl('eglCreatePbufferSurface', C.c_void_p, C.c_void_p, C.c_void_p, C.POINTER(C.c_int))(display, config, (C.c_int * 5)(0x3057, SIZE, 0x3056, SIZE, 0x3038)), 'create pbuffer')
require(egl('eglMakeCurrent', C.c_uint, C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p)(display, surface, surface, context), 'make current')
getstring = gl('glGetString', C.c_char_p, C.c_uint)
renderer = getstring(0x1F01).decode()
version = getstring(0x1F02).decode()
print(f'Native driver: {renderer}; {version}', flush=True)
pack = json.loads(subprocess.check_output(['node', str(ROOT / 'tools/validate-texturing-gpu.mjs')], cwd=ROOT))
create_shader = gl('glCreateShader', C.c_uint, C.c_uint)
shader_source = gl('glShaderSource', None, C.c_uint, C.c_int, C.POINTER(C.c_char_p), C.POINTER(C.c_int))
compile_shader = gl('glCompileShader', None, C.c_uint)
get_shader = gl('glGetShaderiv', None, C.c_uint, C.c_uint, C.POINTER(C.c_int))
shader_log = gl('glGetShaderInfoLog', None, C.c_uint, C.c_int, C.POINTER(C.c_int), C.c_void_p)
create_program = gl('glCreateProgram', C.c_uint)
attach_shader = gl('glAttachShader', None, C.c_uint, C.c_uint)
link_program = gl('glLinkProgram', None, C.c_uint)
get_program = gl('glGetProgramiv', None, C.c_uint, C.c_uint, C.POINTER(C.c_int))
program_log = gl('glGetProgramInfoLog', None, C.c_uint, C.c_int, C.POINTER(C.c_int), C.c_void_p)
delete_shader = gl('glDeleteShader', None, C.c_uint)
delete_program = gl('glDeleteProgram', None, C.c_uint)

def compile_stage(source, kind, label):
    shader = create_shader(kind)
    pointer = C.c_char_p(source.encode())
    shader_source(shader, 1, C.byref(pointer), None)
    compile_shader(shader)
    ok = C.c_int()
    get_shader(shader, 0x8B81, C.byref(ok))
    if not ok.value:
        log = C.create_string_buffer(32768)
        shader_log(shader, len(log), None, log)
        (OUTPUT / f'{label}.glsl').write_text(source)
        raise RuntimeError(f'{label}: {log.value.decode()}')
    return shader

compiled = []
programs = {}
selected = None
for item in pack['programs']:
    label = f"r{item['engine']}-{item['coordinates']}-{item['label']}"
    vertex = compile_stage(item['vertex'], 0x8B31, label + '-vertex')
    fragment = compile_stage(item['fragment'], 0x8B30, label + '-fragment')
    program = create_program()
    attach_shader(program, vertex); attach_shader(program, fragment); link_program(program)
    ok = C.c_int()
    get_program(program, 0x8B82, C.byref(ok))
    if not ok.value:
        log = C.create_string_buffer(32768)
        program_log(program, len(log), None, log)
        raise RuntimeError(f'{label} link: {log.value.decode()}')
    delete_shader(vertex); delete_shader(fragment)
    compiled.append({'case': label, 'compiled': True, 'linked': True})
    print(f'Compiled and linked {label}', flush=True)
    programs[item['id']] = program
    selected = program

use = gl('glUseProgram', None, C.c_uint)
use(selected)
gen_buffers = gl('glGenBuffers', None, C.c_int, C.POINTER(C.c_uint))
bind_buffer = gl('glBindBuffer', None, C.c_uint, C.c_uint)
buffer_data = gl('glBufferData', None, C.c_uint, C.c_ssize_t, C.c_void_p, C.c_uint)
attribute_location = gl('glGetAttribLocation', C.c_int, C.c_uint, C.c_char_p)
attribute_pointer = gl('glVertexAttribPointer', None, C.c_uint, C.c_int, C.c_uint, C.c_ubyte, C.c_int, C.c_void_p)
enable_attribute = gl('glEnableVertexAttribArray', None, C.c_uint)
gen_vaos = gl('glGenVertexArrays', None, C.c_int, C.POINTER(C.c_uint))
bind_vao = gl('glBindVertexArray', None, C.c_uint)
buffers = []
attribute_buffers = {}
for name, value in pack['attributes'].items():
    data = np.asarray(value['data'], dtype=np.float32)
    buffer = C.c_uint(); gen_buffers(1, C.byref(buffer)); buffers.append(buffer)
    bind_buffer(0x8892, buffer)
    buffer_data(0x8892, data.nbytes, data.ctypes.data, 0x88E4)
    attribute_buffers[name] = (buffer, value['size'])
indices = np.asarray(pack['indices'], dtype=np.uint32)
element = C.c_uint(); gen_buffers(1, C.byref(element)); buffers.append(element)
vaos = {}
for key, program in programs.items():
    vao = C.c_uint(); gen_vaos(1, C.byref(vao)); bind_vao(vao)
    for name, (buffer, size) in attribute_buffers.items():
        location = attribute_location(program, name.encode())
        if location < 0: continue
        bind_buffer(0x8892, buffer)
        attribute_pointer(location, size, 0x1406, 0, 0, None)
        enable_attribute(location)
    bind_buffer(0x8893, element)
    buffer_data(0x8893, indices.nbytes, indices.ctypes.data, 0x88E4)
    vaos[key] = vao

gen_textures = gl('glGenTextures', None, C.c_int, C.POINTER(C.c_uint))
active_texture = gl('glActiveTexture', None, C.c_uint)
bind_texture = gl('glBindTexture', None, C.c_uint, C.c_uint)
texture_parameter = gl('glTexParameteri', None, C.c_uint, C.c_uint, C.c_int)
texture_image = gl('glTexImage2D', None, C.c_uint, C.c_int, C.c_int, C.c_int, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_void_p)
generate_mips = gl('glGenerateMipmap', None, C.c_uint)
textures = []
resource_texture_cache = {}
for slot, field in enumerate(['top', 'wall']):
    texture = C.c_uint(); gen_textures(1, C.byref(texture)); textures.append(texture)
    active_texture(0x84C0 + slot); bind_texture(0x0DE1, texture)
    pixels = np.frombuffer(base64.b64decode(pack['textures'][field]), dtype=np.uint8)
    resolution = pack['textures']['resolution']
    texture_image(0x0DE1, 0, 0x8058, resolution, resolution, 0, 0x1908, 0x1401, pixels.ctypes.data)
    texture_parameter(0x0DE1, 0x2801, 0x2703); texture_parameter(0x0DE1, 0x2800, 0x2601)
    texture_parameter(0x0DE1, 0x2802, 0x2901); texture_parameter(0x0DE1, 0x2803, 0x2901)
    generate_mips(0x0DE1)

# WebGLRenderer automatically supplies this engine-owned BRDF lookup. Match it
# exactly; leaving this sampler at unit zero would sample the pigment atlas.
texture = C.c_uint(); gen_textures(1, C.byref(texture)); textures.append(texture)
active_texture(0x84C0 + 2); bind_texture(0x0DE1, texture)
dfg = np.frombuffer(base64.b64decode(pack['textures']['dfg']), dtype=np.uint16)
texture_image(0x0DE1, 0, 0x822F, 16, 16, 0, 0x8227, 0x140B, dfg.ctypes.data)
texture_parameter(0x0DE1, 0x2801, 0x2601); texture_parameter(0x0DE1, 0x2800, 0x2601)
texture_parameter(0x0DE1, 0x2802, 0x812F); texture_parameter(0x0DE1, 0x2803, 0x812F)

def bind_resources(resources):
    """Upload explicit RGBA32F levels; the generated GLSL owns all filtering."""
    for slot, resource in enumerate(resources, 3):
        levels = resource['levels']
        key = tuple((level['width'], level['height'], level['data']) for level in levels)
        texture = resource_texture_cache.get(key)
        active_texture(0x84C0 + slot)
        if texture is None:
            texture = C.c_uint(); gen_textures(1, C.byref(texture)); textures.append(texture)
            bind_texture(0x0DE1, texture)
            for index, level in enumerate(levels):
                pixels = np.frombuffer(base64.b64decode(level['data']), dtype=np.float32)
                if pixels.size != level['width'] * level['height'] * 4:
                    raise RuntimeError(f"Invalid RGBA image level {index} in {resource['uniform']}")
                texture_image(0x0DE1, index, 0x8814, level['width'], level['height'], 0, 0x1908, 0x1406, pixels.ctypes.data)
            texture_parameter(0x0DE1, 0x2801, 0x2600); texture_parameter(0x0DE1, 0x2800, 0x2600)
            texture_parameter(0x0DE1, 0x2802, 0x812F); texture_parameter(0x0DE1, 0x2803, 0x812F)
            texture_parameter(0x0DE1, 0x813D, len(levels) - 1)  # MAX_LEVEL
            resource_texture_cache[key] = texture
        else:
            bind_texture(0x0DE1, texture)

uniform_location = gl('glGetUniformLocation', C.c_int, C.c_uint, C.c_char_p)
uniform_f = gl('glUniform1f', None, C.c_int, C.c_float)
uniform_i = gl('glUniform1i', None, C.c_int, C.c_int)
uniform_u = gl('glUniform1ui', None, C.c_int, C.c_uint)
uniform_vec = {n: gl(f'glUniform{n}fv', None, C.c_int, C.c_int, C.c_void_p) for n in [2, 3, 4]}
uniform_mat = {n: gl(f'glUniformMatrix{n}fv', None, C.c_int, C.c_int, C.c_ubyte, C.c_void_p) for n in [3, 4]}

def uniform(name, value):
    location = uniform_location(selected, name.encode())
    if location < 0: return
    if '_sampler2D_' in name or name in ['uMwTop', 'uMwWall', 'dfgLUT', 'isOrthographic', 'receiveShadow', 'uProbeChannel']:
        uniform_i(location, value)
    elif '_uint_' in name:
        uniform_u(location, value)
    elif isinstance(value, list):
        data = np.asarray(value, dtype=np.float32)
        if len(value) in [9, 16]: uniform_mat[int(len(value) ** 0.5)](location, 1, 0, data.ctypes.data)
        else: uniform_vec[len(value)](location, 1, data.ctypes.data)
    else: uniform_f(location, value)

gl('glViewport', None, C.c_int, C.c_int, C.c_int, C.c_int)(0, 0, SIZE, SIZE)
gl('glEnable', None, C.c_uint)(0x0B71)
clear_color = gl('glClearColor', None, C.c_float, C.c_float, C.c_float, C.c_float)
clear = gl('glClear', None, C.c_uint)
draw = gl('glDrawElements', None, C.c_uint, C.c_int, C.c_uint, C.c_void_p)
finish = gl('glFinish', None)
read = gl('glReadPixels', None, C.c_int, C.c_int, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_void_p)
glerror = gl('glGetError', C.c_uint)
renders = []
for item in pack['cases']:
    selected = programs[item['program']]
    use(selected); bind_vao(vaos[item['program']])
    bind_resources(item.get('resources', []))
    for name, value in item['uniforms'].items(): uniform(name, value)
    clear_color(0.035, 0.045, 0.055, 0)
    clear(0x4000 | 0x0100)
    draw(0x0004, len(indices), 0x1405, None)
    finish()
    pixels = np.empty((SIZE, SIZE, 4), dtype=np.uint8)
    read(0, 0, SIZE, SIZE, 0x1908, 0x1401, pixels.ctypes.data)
    error = glerror()
    if error: raise RuntimeError(f"{item['name']} GL error {hex(error)}")
    pixels = pixels[::-1].copy()
    invalid = int(np.count_nonzero((pixels[:, :, 3] > 0) & (pixels[:, :, 3] < 255)))
    if invalid:
        raise RuntimeError(f"{item['name']}: {invalid} pixels flagged non-finite shader outputs/intermediates")
    foreground = pixels[pixels[:, :, 3] > 0][:, :3]
    if len(foreground) < 100 or float(foreground.std()) < 3:
        raise RuntimeError(f"{item['name']}: missing or constant foreground")
    path = OUTPUT / f"{item['name']}.png"
    Image.fromarray(pixels).save(path)
    stats = {'case': item['name'], 'file': path.name, 'foregroundPixels': len(foreground),
             'meanRGB': foreground.mean(axis=0).tolist(), 'stdRGB': foreground.std(axis=0).tolist(),
             'nonFiniteShaderPixels': invalid, 'finite': invalid == 0, 'glError': error}
    renders.append(stats)
    print(f"Rendered {item['name']}: {len(foreground)} foreground pixels", flush=True)
patch_equivalence = {}
frame_equivalence = {}
channel_equivalence = dict(pack['channelOverrideComposition'])
palette_equivalence = {}
deposit_equivalence = {}
height_effect = {'porcelain': {}, 'weathered': {}}
for distance in ['near', 'far']:
    patched = np.asarray(Image.open(OUTPUT / f'patched-{distance}.png'))
    reference = np.asarray(Image.open(OUTPUT / f'reference-{distance}.png'))
    identical = bool(np.array_equal(patched, reference))
    if not identical:
        raise RuntimeError(f'Live patch differs from fresh equivalent graph at {distance} distance')
    patch_equivalence[distance] = {'pixelIdentical': identical}
    framed = np.asarray(Image.open(OUTPUT / f'framed-{distance}.png'))
    explicit = np.asarray(Image.open(OUTPUT / f'frame-reference-{distance}.png'))
    same_frame = bool(np.array_equal(framed, explicit))
    if not same_frame:
        raise RuntimeError(f'Whole-composition domain binding differs from explicit domains at {distance} distance')
    frame_equivalence[distance] = {'pixelIdentical': same_frame}
    nested = np.asarray(Image.open(OUTPUT / f'channel-nested-{distance}.png'))
    flat = np.asarray(Image.open(OUTPUT / f'channel-flat-{distance}.png'))
    same_channels = bool(np.array_equal(nested, flat))
    if not same_channels:
        raise RuntimeError(f'Nested channel overrides differ from their flat composition at {distance} distance')
    channel_equivalence[distance] = {'pixelIdentical': same_channels}
    palette = np.asarray(Image.open(OUTPUT / f'palette-clipped-{distance}.png'))
    legacy_palette = np.asarray(Image.open(OUTPUT / f'palette-reference-{distance}.png'))
    same_palette = bool(np.array_equal(palette, legacy_palette))
    if not same_palette:
        raise RuntimeError(f'Explicit clamped palette differs from the legacy palette at {distance} distance')
    palette_equivalence[distance] = {'pixelIdentical': same_palette}
    deposited = np.asarray(Image.open(OUTPUT / f'deposit-pigment-{distance}.png'))
    expected = np.asarray(Image.open(OUTPUT / f'deposit-reference-{distance}.png'))
    same_deposit = bool(np.array_equal(deposited, expected))
    if not same_deposit:
        raise RuntimeError(f'Associated deposition differs from explicit component values at {distance}')
    deposit_equivalence[distance] = {'pixelIdentical': same_deposit}
    for name in height_effect:
        detailed = np.asarray(Image.open(OUTPUT / f'{name}-{distance}.png'))
        flat = np.asarray(Image.open(OUTPUT / f'{name}-flat-{distance}.png'))
        changed = int(np.count_nonzero(np.any(detailed[:, :, :3] != flat[:, :, :3], axis=2)))
        same_silhouette = bool(np.array_equal(detailed[:, :, 3], flat[:, :, 3]))
        if not changed or not same_silhouette:
            raise RuntimeError(f'{name}: expected shading detail with the same silhouette at {distance}')
        height_effect[name][distance] = {'changedPixels': changed, 'sameSilhouette': same_silhouette}

optimization_equivalence = {}
for pair in pack.get('optimizationPairs', []):
    comparisons = {}
    for distance in ['near', 'far']:
        before_file = f"{pair['before']}-{distance}.png"
        after_file = f"{pair['after']}-{distance}.png"
        before = np.asarray(Image.open(OUTPUT / before_file))
        after = np.asarray(Image.open(OUTPUT / after_file))
        difference = np.abs(before.astype(np.int16) - after.astype(np.int16))
        maximum = int(difference.max())
        changed = int(np.count_nonzero(np.any(difference, axis=2)))
        identical = bool(np.array_equal(before, after))
        comparisons[distance] = {
            'before': before_file, 'after': after_file,
            'rgbaByteIdentical': identical, 'differentPixels': changed,
            'maxAbsoluteChannelDifference': maximum,
            'beforeRGBASHA256': sha256(before.tobytes()).hexdigest(),
            'afterRGBASHA256': sha256(after.tobytes()).hexdigest(),
        }
        if not identical:
            raise RuntimeError(f"Optimized {pair['id']} differs at {distance}: {changed} pixels, max channel difference {maximum}")
    optimization_equivalence[pair['id']] = {
        'label': pair.get('label'), 'sourceSHA256': pair['sourceSHA256'], **comparisons,
    }
    print(f"Optimization {pair['id']}: near/far RGBA bytes identical", flush=True)

# Probe generated procedural/color programs through a native driver. Pack
# each float into RGBA8 bytes so the comparison is not limited by image colors.
gl('glDisable', None, C.c_uint)(0x0B71)  # depth
gl('glDisable', None, C.c_uint)(0x0BD0)  # dithering would corrupt packed bits
gl('glViewport', None, C.c_int, C.c_int, C.c_int, C.c_int)(0, 0, 1, 1)
draw_arrays = gl('glDrawArrays', None, C.c_uint, C.c_int, C.c_int)

def sample_probes(probes):
    global selected
    selected = programs[probes['program']]
    use(selected); bind_vao(vaos[probes['program']])
    results = []
    for item in probes['cases']:
        bind_resources(item.get('resources', []))
        for name, value in item['uniforms'].items(): uniform(name, value)
        actual = []
        for channel in range(3):
            uniform('uProbeChannel', channel)
            draw_arrays(0x0004, 0, 3)
            pixel = np.empty(4, dtype=np.uint8)
            read(0, 0, 1, 1, 0x1908, 0x1401, pixel.ctypes.data)
            actual.append(struct.unpack('<f', pixel.tobytes())[0])
        error = glerror()
        difference = float(np.max(np.abs(np.array(actual) - item['expected'])))
        if error or not np.all(np.isfinite(actual)) or difference > probes['tolerance']:
            raise RuntimeError(f"{probes['program']} parity {item['label']}: CPU {item['expected']} GPU {actual}, error {difference}, GL {hex(error)}")
        results.append({'case': item['label'], 'expected': item['expected'], 'actual': actual, 'maxAbsoluteError': difference})
    result = {'program': probes['program'], 'samples': len(results), 'components': len(results) * 3,
              'maxAbsoluteError': max(item['maxAbsoluteError'] for item in results),
              'tolerance': probes['tolerance'], 'passed': True, 'cases': results}
    if 'kind' in probes:
        result['kind'] = probes['kind']
    print(f"{probes['program']} CPU/GPU parity: {len(results)} samples, max error {result['maxAbsoluteError']}", flush=True)
    return result

procedural_parity = sample_probes(pack['proceduralProbes'])
color_parity = [sample_probes(group) for group in pack['colorProbes']]
differential_parity = [sample_probes(group) for group in pack['differentialProbes']]
resource_parity = [sample_probes(group) for group in pack['resourceProbes']]
report = {'backend': 'native surfaceless EGL / GLES3', 'renderer': renderer, 'version': version,
          'finiteCheck': 'GLSL isnan/isinf guard on final output, shading normal, pigment and authored slope; alpha sentinel counted on CPU',
          'provenance': pack['provenance'], 'sourceSHA256': pack['sourceSHA256'],
          'specimen': pack['specimen'], 'compiled': compiled, 'renders': renders,
          'livePatchMatchesFreshGraph': patch_equivalence,
          'domainBindingMatchesExplicitFrames': frame_equivalence,
          'channelOverrideComposition': channel_equivalence,
          'paintPaletteMatchesCanonicalColors': palette_equivalence,
          'associatedDepositionMatchesExplicitComponents': deposit_equivalence,
          'heightChangesShadingOnly': height_effect,
          'proceduralColorParity': procedural_parity,
          'colorGrammarParity': {'samples': sum(group['samples'] for group in color_parity),
                                'components': sum(group['components'] for group in color_parity),
                                'maxAbsoluteError': max(group['maxAbsoluteError'] for group in color_parity),
                                'passed': True, 'groups': color_parity},
          'heightDifferentialParity': {'samples': sum(group['samples'] for group in differential_parity),
                                      'components': sum(group['components'] for group in differential_parity),
                                      'maxAbsoluteError': max(group['maxAbsoluteError'] for group in differential_parity),
                                      'passed': True, 'groups': differential_parity},
          'resourceFieldParity': {'samples': sum(group['samples'] for group in resource_parity),
                                  'components': sum(group['components'] for group in resource_parity),
                                  'maxAbsoluteError': max(group['maxAbsoluteError'] for group in resource_parity),
                                  'passed': True, 'groups': resource_parity},
          'diagnostic': os.environ.get('MOONWEAVE_NATIVE_DIAGNOSTIC'),
          'limitations': 'Native Mesa software driver, not browser WebGL. Static geometry only; does not measure interactive browser frame rate or animation.'}
if optimization_equivalence:
    report['optimizationEffectEquivalence'] = optimization_equivalence
(OUTPUT / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
for program in programs.values(): delete_program(program)
egl('eglMakeCurrent', C.c_uint, C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p)(display, None, None, None)
egl('eglDestroySurface', C.c_uint, C.c_void_p, C.c_void_p)(display, surface)
egl('eglDestroyContext', C.c_uint, C.c_void_p, C.c_void_p)(display, context)
egl('eglTerminate', C.c_uint, C.c_void_p)(display)
print(json.dumps({'passed': True, 'programs': len(compiled), 'renders': len(renders), 'report': str(OUTPUT / 'report.json')}))
