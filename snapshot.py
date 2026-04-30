import os

def create_snapshot():
    # Files we care about
    targets = [
        'lab_site/index.html',
        'lab_site/challenges.html',
        'lab_site/challenge_modules/reading-behavior/reading-behavior.html',
        'lab_site/challenge_modules/comparison-choice/comparison-choice.html',
        'lab_site/challenge_modules/friction-persistence/friction-persistence.html',
        'lab_site/challenge_modules/speed-accuracy/speed-accuracy.html',
        'lab_site/challenge_modules/confidence-calibration/confidence-calibration.html',
        'lab_site/challenge_modules/social-risk/social-risk.html',
        'lab_site/challenge_modules/search-browse/search-browse.html',
        'lab_site/js/comparison-challenge.js',
        'lab_site/js/friction-challenge.js',
        'lab_site/js/speed-challenge.js',
        'lab_site/css/speed-challenge.css',
        'lab_site/js/calibration-challenge.js',
        'lab_site/css/calibration-challenge.css',
        'lab_site/js/social-risk-challenge.js',
        'lab_site/css/social-risk-challenge.css',
        'lab_site/js/search-browse-challenge.js',
        'lab_site/css/search-browse-challenge.css',
        'lab_site/demo.html',
        'lab_site/worker.js',
        'lab_site/js/behavioral-service.js',
        'lab_site/js/app.js',
        'lab_site/js/reading-challenge.js',
        'lab_site/main.js',
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