-- Fix Existing Admin Users
-- This script adds missing Admin records for users with 'Admin' role

-- Insert Admin records for users who have 'Admin' role but no Admin record
INSERT INTO Admin (Admin_ID)
SELECT u.User_ID
FROM [User] u
LEFT JOIN Admin a ON u.User_ID = a.Admin_ID
WHERE u.Role = 'Admin' AND a.Admin_ID IS NULL;

-- Verify the results
SELECT 
    u.User_ID,
    u.Name,
    u.Email,
    u.Role,
    CASE WHEN a.Admin_ID IS NOT NULL THEN 'Yes' ELSE 'No' END as Has_Admin_Record
FROM [User] u
LEFT JOIN Admin a ON u.User_ID = a.Admin_ID
WHERE u.Role = 'Admin';
