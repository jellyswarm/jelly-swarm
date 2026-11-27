import {GLASS} from './config';

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// One full-canvas pass: track + grey labels everywhere, then the lens on top.
// All lengths are device px with y pointing down, matching the 2D scene canvases.
const FRAG = `
precision highp float;

uniform sampler2D uTrack;   // premultiplied colour
uniform sampler2D uText;    // labels in alpha
uniform vec2 uRes;
uniform vec2 uCenter;       // lens centre
uniform vec2 uHalf;         // lens half size (x >= y)
uniform float uBevel;       // rim width
uniform float uLift;        // 0 resting .. 1 picked up
uniform float uSpin;        // orbiting light angle
uniform float uTime;
uniform vec2 uPointer;      // x: angle to pointer, y: strength
uniform vec3 uPage;
uniform vec3 uInkIdle;
uniform vec3 uInkActive;
uniform vec3 uBody;
uniform float uTint;
uniform float uRefract;
uniform float uDispersion;

float sdPill(vec2 p, vec2 b) {
  vec2 q = vec2(abs(p.x) - (b.x - b.y), abs(p.y));
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - b.y;
}

// Outward direction of the nearest edge.
vec2 pillDir(vec2 p, vec2 b) {
  vec2 q = vec2(abs(p.x) - (b.x - b.y), abs(p.y));
  vec2 n = q.x > 0.0 ? q / max(length(q), 1e-4) : vec2(0.0, 1.0);
  return n * vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
}

vec3 hue(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

vec4 track(vec2 p) { return texture2D(uTrack, p / uRes); }
float label(vec2 p) { return texture2D(uText, p / uRes).a; }

float lobe(vec3 n, float a, float elev, float shin) {
  vec3 L = normalize(vec3(cos(a), sin(a), elev));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  return pow(max(dot(n, H), 0.0), shin);
}

// A light whose red and blue arrive at slightly different angles: rainbow glints.
vec3 glint(vec3 n, float a, float elev, float shin) {
  float s = 0.11;
  return vec3(lobe(n, a - s, elev, shin), lobe(n, a, elev, shin), lobe(n, a + s, elev, shin));
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);

  // Track with idle grey labels.
  vec4 col = track(p);
  float ta = label(p);
  col.rgb = uInkIdle * ta + col.rgb * (1.0 - ta);
  col.a = ta + col.a * (1.0 - ta);

  vec2 lp = p - uCenter;
  float d = sdPill(lp, uHalf);
  float h = uHalf.y * 2.0;

  // Soft cast shadow that grows as the lens lifts, plus a tight contact shadow.
  float ds = sdPill(lp - vec2(0.0, h * (0.05 + 0.06 * uLift)), uHalf * vec2(0.99, 0.96));
  float sh = (1.0 - smoothstep(-h * 0.12, h * (0.17 + 0.14 * uLift), ds)) * (0.14 + 0.05 * uLift);
  sh += (1.0 - smoothstep(-1.0, h * 0.045, d)) * 0.07 * (1.0 - 0.6 * uLift);
  sh = clamp(sh, 0.0, 0.32);
  col.rgb *= 1.0 - sh;
  col.a = sh + col.a * (1.0 - sh);

  float mask = clamp(0.5 - d, 0.0, 1.0);
  if (mask > 0.0) {
    float u = clamp(-d / uBevel, 0.0, 1.0);  // 0 at the edge, 1 on the flat top
    float e = 1.0 - u;
    vec2 dir = pillDir(lp, uHalf);
    vec3 n = normalize(vec3(dir * e, sqrt(max(1.0 - e * e, 0.0)) + 1e-3));

    // Rim refraction pulls in what lies beyond the edge; lifting magnifies the middle.
    vec2 off = dir * pow(e, 1.7) * uBevel * uRefract * (1.0 + 0.35 * uLift);
    vec2 mag = -lp * 0.05 * uLift;
    vec2 oR = off * (1.0 - uDispersion * 0.5) + mag;
    vec2 oG = off + mag;
    vec2 oB = off * (1.0 + uDispersion * 0.5) + mag;
    vec4 tR = track(p + oR);
    vec4 tG = track(p + oG);
    vec4 tB = track(p + oB);
    vec3 under = vec3(
      tR.r + uPage.r * (1.0 - tR.a),
      tG.g + uPage.g * (1.0 - tG.a),
      tB.b + uPage.b * (1.0 - tB.a)
    );
    vec3 ink = vec3(label(p + oR), label(p + oG), label(p + oB));

    // Milky body, clearer on the rim so the refraction reads.
    vec3 g = mix(under, uBody, uTint * (0.3 + 0.7 * u));
    g = mix(g, uInkActive, ink);

    // Rim shading: a grey band down the bevel, a bright lip at the very edge.
    float band = smoothstep(0.05, 0.55, e) * (1.0 - smoothstep(0.72, 0.98, e));
    g *= 1.0 - 0.1 * band * (0.75 + 0.25 * max(dir.y, 0.0));
    g += vec3(0.17) * smoothstep(0.84, 1.0, e);
    g += vec3(0.045) * smoothstep(0.25, 0.9, e) * max(-dir.y, 0.0);

    // Three orbiting lights, each slowly shifting hue, plus one that follows the pointer.
    float t = uTime;
    vec3 c0 = mix(vec3(1.0), hue(fract(t * 0.045)), 0.4);
    vec3 c1 = mix(vec3(1.0), hue(fract(t * 0.03 + 0.33)), 0.5);
    vec3 c2 = mix(vec3(1.0), hue(fract(t * 0.06 + 0.66)), 0.45);
    vec3 sp = glint(n, uSpin, -0.18, 85.0) * c0 * 0.95
            + glint(n, -uSpin * 0.73 + 2.1, -0.1, 120.0) * c1 * 0.8
            + glint(n, uSpin * 0.41 + 4.2, -0.26, 70.0) * c2 * 0.55
            + glint(n, uPointer.x, -0.14, 95.0) * uPointer.y * 0.55;
    g += sp;

    col = vec4(min(g, vec3(1.0)), 1.0) * mask + col * (1.0 - mask);
  }

  gl_FragColor = col;
}
`;

export type Frame = {
  center: [number, number];
  half: [number, number];
  bevel: number;
  lift: number;
  spin: number;
  time: number;
  pointer: [number, number];
};

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
  }
  return sh;
}

export class GlassRenderer {
  private gl: WebGLRenderingContext;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private texTrack: WebGLTexture;
  private texText: WebGLTexture;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', {alpha: true, premultipliedAlpha: true, antialias: false});
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? 'program link failed');
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    for (const name of [
      'uTrack', 'uText', 'uRes', 'uCenter', 'uHalf', 'uBevel', 'uLift', 'uSpin', 'uTime',
      'uPointer', 'uPage', 'uInkIdle', 'uInkActive', 'uBody', 'uTint', 'uRefract', 'uDispersion',
    ]) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }

    this.texTrack = this.makeTexture(0);
    this.texText = this.makeTexture(1);
    gl.uniform1i(this.u.uTrack, 0);
    gl.uniform1i(this.u.uText, 1);
    gl.uniform3fv(this.u.uPage, GLASS.page);
    gl.uniform3fv(this.u.uInkIdle, GLASS.inkIdle);
    gl.uniform3fv(this.u.uInkActive, GLASS.inkActive);
    gl.uniform3fv(this.u.uBody, GLASS.body);
    gl.uniform1f(this.u.uTint, GLASS.tint);
    gl.uniform1f(this.u.uRefract, GLASS.refract);
    gl.uniform1f(this.u.uDispersion, GLASS.dispersion);
  }

  private makeTexture(unit: number) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  /** Re-upload the scene layers; the canvas takes their size. */
  upload(track: HTMLCanvasElement, text: HTMLCanvasElement) {
    const gl = this.gl;
    this.canvas.width = track.width;
    this.canvas.height = track.height;
    gl.viewport(0, 0, track.width, track.height);
    gl.uniform2f(this.u.uRes, track.width, track.height);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    for (const [unit, tex, src] of [[0, this.texTrack, track], [1, this.texText, text]] as const) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
  }

  draw(f: Frame) {
    const gl = this.gl;
    gl.uniform2f(this.u.uCenter, f.center[0], f.center[1]);
    gl.uniform2f(this.u.uHalf, f.half[0], f.half[1]);
    gl.uniform1f(this.u.uBevel, f.bevel);
    gl.uniform1f(this.u.uLift, f.lift);
    gl.uniform1f(this.u.uSpin, f.spin);
    gl.uniform1f(this.u.uTime, f.time);
    gl.uniform2f(this.u.uPointer, f.pointer[0], f.pointer[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
