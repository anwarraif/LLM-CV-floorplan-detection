import sys
import os
import psycopg2

def main():
    # Read .env
    env = {}
    with open("c:/YUSUF/My-Job/yup/as-ai-predraw-floorplans/.env") as f:
        for line in f:
            if '=' in line:
                k, v = line.strip().split('=', 1)
                env[k.strip()] = v.strip()
                
    db_host = env.get("DB_HOST", "localhost")
    db_port = env.get("DB_PORT", "5432")
    db_name = env.get("DB_NAME", "floor_plan_tool")
    db_user = env.get("DB_USER", "postgres")
    db_password = env.get("DB_PASSWORD", "")
    
    print(f"Connecting to {db_host}:{db_port}/{db_name} as {db_user}...")
    try:
        conn = psycopg2.connect(
            host=db_host,
            port=db_port,
            database=db_name,
            user=db_user,
            password=db_password
        )
        cursor = conn.cursor()
        cursor.execute("""
            SELECT fp.id, a.name, fp.uploaded_at, fp.original_filename, fp.image_url 
            FROM floor_plans fp
            JOIN apartments a ON fp.apartment_id = a.id
            ORDER BY fp.uploaded_at DESC 
            LIMIT 5
        """)
        rows = cursor.fetchall()
        print(f"Found {len(rows)} floor plans:")
        for row in rows:
            print(f"ID: {row[0]} | Apartment: {row[1]} | Uploaded: {row[2]} | Filename: {row[3]} | URL: {row[4]}")
        cursor.close()
        conn.close()
    except Exception as e:
        print("Database error:", e)

if __name__ == "__main__":
    main()
