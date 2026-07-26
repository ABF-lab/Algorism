import pg8000
import sys

def init_db():
    print("Connecting to Supabase PostgreSQL database...")
    conn = None
    
    # Try port 5432 (direct) first, then 6543 (pooler)
    for port in [5432, 6543]:
        try:
            print(f"Trying connection on port {port}...")
            conn = pg8000.connect(
                user="postgres",
                password="9edDwwGOSQCn5EGt",
                host="db.wrzydzgyywwfffjojzko.supabase.co",
                port=port,
                database="postgres"
            )
            print(f"Connected successfully on port {port}!")
            break
        except Exception as e:
            print(f"Connection on port {port} failed: {e}")
            
    if conn is None:
        print("\nCould not connect to Supabase database. Please check:")
        print("1. Your internet connection.")
        print("2. If your network blocks standard PostgreSQL ports (5432/6543).")
        sys.exit(1)
        
    try:
        cursor = conn.cursor()
        
        # Read the SQL migration script
        print("Reading setup_supabase.sql...")
        with open("setup_supabase.sql", "r", encoding="utf-8") as f:
            sql_script = f.read()

        print("Executing schema scripts on Supabase...")
        cursor.execute(sql_script)
        conn.commit()
        
        print("Database schema and sync_records RPC function initialized successfully!")
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"Error executing database script: {e}")
        sys.exit(1)

if __name__ == "__main__":
    init_db()
