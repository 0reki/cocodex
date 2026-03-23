export function LoginBackground() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div
        className="absolute inset-0"
        style={{ backgroundColor: "rgb(239, 238, 254)" }}
      />
      <video
        className="absolute inset-0 h-full w-full object-cover"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        poster="/floral_a.webp"
      >
        <source
          src="https://cdn.openai.com/ctf-cdn/floral_a.mp4"
          type="video/mp4"
        />
      </video>
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(239,238,254,0.04)_0%,rgba(239,238,254,0.02)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_32%,rgba(255,255,255,0.06)_0%,rgba(255,255,255,0)_54%)]" />
    </div>
  );
}
