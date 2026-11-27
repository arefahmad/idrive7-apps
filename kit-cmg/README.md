# kit-cmg

A copy of cauliflowermossgrape's MGU App Kit (github.com/cauliflowermossgrape/idrive7-apps, `kit/`, commit f54fc27,
MIT: see LICENSE) for the apps here that start from one of his apps and need his newer kit (background service, safe
boot, Stop all): an app.json with `"kit": "kit-cmg"` is built by `kit-cmg/tools/build.py`, which `kit/tools/build.py`
hands it to. The other apps keep `kit/`. Only `runtime`, `tools`, `platform` and `icons` are here (English builds).
