import os

def create_snapshot():
    # Files we care about
    targets = [
        'lab_site/demo.html', 
        'lab_site/main.js', 
        'lab_site/worker.js', 
        'collector/collector.js',
        'scripts/generate_signatures.py'
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