import os

def create_snapshot():
    # Files we care about (product + collector)
    targets = [
        'lab_console/console/index.html',
        'lab_console/dashboard.html',
        'lab_console/dashboard.js',
        'lab_console/segmentation.html',
        'lab_console/js/nexus-env.js',
        'lab_console/js/nexus-segmentation.js',
        'lab_console/js/segmentation-page.js',
        'collector/collector.js',
        'scripts/generate_signatures.py',
    ]

    with open("project_snapshot.txt", "w") as f:
        for path in targets:
            if os.path.exists(path):
                f.write(f"\n--- FILE: {path} ---\n")
                with open(path, 'r') as content:
                    f.write(content.read())
                f.write(f"\n--- END FILE ---\n")
    print("✅ project_snapshot.txt created. Upload this file to Gemini.")

if __name__ == "__main__":
    create_snapshot()
