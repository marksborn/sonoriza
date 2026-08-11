from pathlib import Path

path = Path("src/services/configuration-readiness.test.ts")
text = path.read_text()
old = r'/simulation\.status === "SUCCESS" && gate\.realRunAllowed/'
new = r'/simulation\.status === "SUCCESS"\s*&&\s*gate\.realRunAllowed/'
if text.count(old) != 1:
    raise SystemExit(f"expected one brittle CONFIG-04 gate regex, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
