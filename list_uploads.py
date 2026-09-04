import os
import glob

def main():
    path = "c:/YUSUF/My-Job/yup/as-ai-predraw-floorplans/backend/uploads"
    files = glob.glob(os.path.join(path, "**/*"), recursive=True)
    files = [f for f in files if os.path.isfile(f)]
    # sort by modification time descending
    files.sort(key=lambda x: os.path.getmtime(x), reverse=True)
    
    print(f"Total files found: {len(files)}")
    for f in files[:15]:
        rel = os.path.relpath(f, path)
        mtime = os.path.getmtime(f)
        import datetime
        dt = datetime.datetime.fromtimestamp(mtime)
        print(f"{rel} | Size: {os.path.getsize(f)} | Modified: {dt}")

if __name__ == "__main__":
    main()
