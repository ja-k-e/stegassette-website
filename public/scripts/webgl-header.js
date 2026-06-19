export class WebglHeader {
  constructor(canvas, images) {
    this.canvas = canvas;
    this.images = images;
    this.gl = canvas.getContext("webgl", { alpha: false, antialias: true });
    this.sprites = [];
    this.textures = [];
    this.raf = 0;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  start() {
    if (!this.gl) return false;
    const gl = this.gl;
    const vs = `
      attribute vec2 a_pos;
      attribute vec2 a_uv;
      uniform vec2 u_res;
      uniform vec2 u_center;
      uniform float u_size;
      uniform float u_rotation;
      varying vec2 v_uv;
      void main() {
        vec2 local = (a_pos - 0.5) * u_size;
        float c = cos(u_rotation);
        float s = sin(u_rotation);
        vec2 px = u_center + mat2(c, s, -s, c) * local;
        vec2 clip = (px / u_res) * 2.0 - 1.0;
        gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
        v_uv = a_uv;
      }
    `;
    const fs = `
      precision mediump float;
      uniform sampler2D u_tex;
      varying vec2 v_uv;
      void main() {
        vec4 color = texture2D(u_tex, v_uv);
        gl_FragColor = vec4(color.rgb, 1.0);
      }
    `;

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };

    this.program = gl.createProgram();
    gl.attachShader(this.program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(this.program);
    gl.useProgram(this.program);

    const data = new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1]);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(this.program, "a_pos");
    const aUv = gl.getAttribLocation(this.program, "a_uv");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

    this.locations = {
      res: gl.getUniformLocation(this.program, "u_res"),
      center: gl.getUniformLocation(this.program, "u_center"),
      size: gl.getUniformLocation(this.program, "u_size"),
      rotation: gl.getUniformLocation(this.program, "u_rotation"),
      tex: gl.getUniformLocation(this.program, "u_tex"),
    };

    this.textures = this.images.map((src) => this.loadTexture(src));
    gl.disable(gl.BLEND);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.render(0);
    return true;
  }

  loadTexture(src) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([18, 18, 18, 255]));
    const image = new Image();
    image.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    image.src = src;
    return texture;
  }

  resize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, width);
    this.canvas.height = Math.max(1, height);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (!this.sprites.length) {
      this.sprites = this.makeSprites();
    }
  }

  makeSprites() {
    const layout = [
      { x: 0.12, y: 0.3, size: 0.42, rotation: -0.07, dx: 90, dy: 76, phase: 0.2 },
      { x: 0.77, y: 0.27, size: 0.56, rotation: 0.06, dx: 116, dy: 82, phase: 1.4 },
      { x: 0.42, y: 0.7, size: 0.34, rotation: -0.03, dx: 86, dy: 74, phase: 2.3 },
      { x: 0.04, y: 0.67, size: 0.25, rotation: 0.09, dx: 126, dy: 58, phase: 3.1 },
      { x: 0.94, y: 0.62, size: 0.3, rotation: -0.1, dx: 112, dy: 96, phase: 4.1 },
      { x: 0.34, y: 0.17, size: 0.22, rotation: 0.04, dx: 78, dy: 62, phase: 5.0 },
      { x: 0.66, y: 0.86, size: 0.24, rotation: 0.1, dx: 104, dy: 80, phase: 5.9 },
      { x: 0.52, y: 0.08, size: 0.2, rotation: -0.08, dx: 84, dy: 52, phase: 6.6 },
    ];
    const base = Math.min(this.canvas.width, this.canvas.height);
    return layout.slice(0, Math.max(3, Math.min(layout.length, this.images.length))).map((item, i) => ({
      ...item,
      texture: i % this.images.length,
      sizePx: Math.max(112, Math.min(560, item.size * base)),
    }));
  }

  render(time) {
    const gl = this.gl;
    gl.clearColor(0.04, 0.04, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.locations.res, this.canvas.width, this.canvas.height);
    const t = this.reduced ? 0 : time * 0.001;

    for (const sprite of this.sprites) {
      const x = sprite.x * this.canvas.width + Math.sin(t * 0.19 + sprite.phase) * sprite.dx;
      const y = sprite.y * this.canvas.height + Math.cos(t * 0.16 + sprite.phase) * sprite.dy;
      const rotation = sprite.rotation + Math.sin(t * 0.13 + sprite.phase) * 0.028;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[sprite.texture]);
      gl.uniform1i(this.locations.tex, 0);
      gl.uniform2f(this.locations.center, x, y);
      gl.uniform1f(this.locations.size, sprite.sizePx);
      gl.uniform1f(this.locations.rotation, rotation);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    this.raf = requestAnimationFrame((next) => this.render(next || time));
  }
}
